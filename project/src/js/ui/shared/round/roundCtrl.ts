import { throttle } from 'lodash';
import redraw from '../../../utils/redraw';
import { saveOfflineGameData } from '../../../utils/offlineGames';
import { hasNetwork, boardOrientation, formatTimeInSecs, oppositeColor, noop } from '../../../utils';
import i18n from '../../../i18n';
import gameStatus from '../../../lichess/status';
import session from '../../../session';
import socket from '../../../socket';
import signals from '../../../signals';
import router from '../../../router';
import sound from '../../../sound';
import { miniUser as miniUserXhr, toggleGameBookmark } from '../../../xhr';
import vibrate from '../../../vibrate';
import gameApi from '../../../lichess/game';
import backbutton from '../../../backbutton';
import { gameTitle } from '../../shared/common';

import round from './round';
import ground from './ground';
import promotion from './promotion';
import chat from './chat';
import notes from './notes';
import clockCtrl from './clock/clockCtrl';
import correspondenceClockCtrl from './correspondenceClock/corresClockCtrl';
import socketHandler from './socketHandler';
import atomic from './atomic';
import * as xhr from './roundXhr';
import crazyValid from './crazy/crazyValid';

export default function (vnode: Mithril.Vnode, cfg: GameData, onFeatured: () => void, onTVChannelChange: () => void, userTv: string, onUserTVRedirect: () => void) {

  this.data = round.merge({}, cfg).data;

  this.onTVChannelChange = onTVChannelChange;

  this.vm = {
    ply: round.lastPly(this.data),
    flip: false,
    miniUser: {
      player: {
        showing: false,
        data: null
      },
      opponent: {
        showing: false,
        data: null
      }
    },
    showingActions: false,
    confirmResign: false,
    goneBerserk: {},
    moveToSubmit: null,
    dropToSubmit: null,
    tClockEl: null
  };
  this.vm.goneBerserk[this.data.player.color] = this.data.player.berserk;
  this.vm.goneBerserk[this.data.opponent.color] = this.data.opponent.berserk;

  let tournamentCountInterval: number;
  const tournamentTick = function() {
    if (this.data.tournament.secondsToFinish > 0) {
      this.data.tournament.secondsToFinish--;
      if (this.vm.tClockEl) {
        this.vm.tClockEl.textContent =
          formatTimeInSecs(this.data.tournament.secondsToFinish) +
        ' • ';
      }
    } else {
      clearInterval(tournamentCountInterval);
    }
  }.bind(this);

  if (this.data.tournament) {
    tournamentCountInterval = setInterval(tournamentTick, 1000);
  }

  const connectSocket = function() {
    if (hasNetwork()) {
      socket.createGame(
        this.data.url.socket,
        this.data.player.version,
        socketHandler(this, onFeatured, onUserTVRedirect),
        this.data.url.round,
        userTv
      );
    }
  }.bind(this);

  connectSocket();

  // reconnect game socket after a cancelled seek
  signals.seekCanceled.add(connectSocket);

  // TODO type steps
  this.stepsHash = function(steps: any) {
    let h = '';
    for (let i in steps) {
      h += steps[i].san;
    }
    return h;
  };

  this.toggleUserPopup = function(position: string, userId: string) {
    if (!this.vm.miniUser[position].data) {
      miniUserXhr(userId).then(data => {
        this.vm.miniUser[position].data = data;
      });
    }
    this.vm.miniUser[position].showing = !this.vm.miniUser[position].showing;
  }.bind(this);

  this.showActions = function() {
    backbutton.stack.push(this.hideActions);
    this.vm.showingActions = true;
  }.bind(this);

  this.hideActions = function(fromBB?: string) {
    if (fromBB !== 'backbutton' && this.vm.showingActions) backbutton.stack.pop();
    this.vm.showingActions = false;
  }.bind(this);

  this.flip = function() {
    if (this.data.tv) {
      if (vnode.attrs.flip) router.set('/tv?flip=1', true);
      else router.set('/tv', true);
      return;
    } else if (this.data.player.spectator) {
      router.set('/game/' + this.data.game.id + '/' +
        oppositeColor(this.data.player.color), true);
      return;
    }
    this.vm.flip = !this.vm.flip;
    this.chessground.set({
      orientation: boardOrientation(this.data, this.vm.flip)
    });
  }.bind(this);

  this.replaying = function() {
    return this.vm.ply !== round.lastPly(this.data);
  }.bind(this);

  this.canDrop = function() {
    return !this.replaying() && gameApi.isPlayerPlaying(this.data);
  }.bind(this);

  this.jump = function(ply: number) {
    if (ply < round.firstPly(this.data) || ply > round.lastPly(this.data)) return false;
    const isFwd = ply > this.vm.ply;
    this.vm.ply = ply;
    const s = round.plyStep(this.data, ply);
    const config: Chessground.SetConfig = {
      fen: s.fen,
      lastMove: s.uci ? [s.uci.substr(0, 2), s.uci.substr(2, 2)] : null,
      check: s.check,
      turnColor: this.vm.ply % 2 === 0 ? 'white' : 'black'
    };
    if (!this.replaying()) {
      config.movableColor = gameApi.isPlayerPlaying(this.data) ? this.data.player.color : null;
      config.dests = gameApi.parsePossibleMoves(this.data.possibleMoves);
    }
    this.chessground.set(config);
    if (this.replaying()) this.chessground.stop();
    if (s.san && isFwd) {
      if (s.san.indexOf('x') !== -1) sound.capture();
      else sound.move();
    }
    return true;
  }.bind(this);

  this.jumpNext = function() {
    return this.jump(this.vm.ply + 1);
  }.bind(this);

  this.jumpPrev = function() {
    return this.jump(this.vm.ply - 1);
  }.bind(this);

  this.jumpFirst = function() {
    return this.jump(round.firstPly(this.data));
  }.bind(this);

  this.jumpLast = function() {
    return this.jump(round.lastPly(this.data));
  }.bind(this);

  this.setTitle = function() {
    if (this.data.tv)
      this.title = 'Lichess TV';
    else if (this.data.userTV)
      this.title = this.data.userTV;
    else if (gameStatus.started(this.data))
      this.title = gameTitle(this.data);
    else if (gameStatus.finished(this.data))
      this.title = i18n('gameOver');
    else if (gameStatus.aborted(this.data))
      this.title = i18n('gameAborted');
    else
      this.title = 'lichess.org';
  };
  this.setTitle();

  this.sendMove = function(orig: Pos, dest: Pos, prom: string, isPremove: boolean) {
    const move = {
      u: orig + dest
    };
    if (prom) {
      move.u += (prom === 'knight' ? 'n' : prom[0]);
    }

    if (this.data.pref.submitMove && !isPremove) {
      setTimeout(() => {
        backbutton.stack.push(this.cancelMove);
        this.vm.moveToSubmit = move;
        redraw();
      }, this.data.pref.animationDuration || 0);
    } else {
      socket.send('move', move, {
        ackable: true,
        withLag: !!this.clock
      });
      if (this.data.game.speed === 'correspondence' && !hasNetwork()) {
        window.plugins.toast.show('You need to be connected to Internet to send your move.', 'short', 'center');
      }
    }
  };

  this.sendNewPiece = function(role: Role, key: Pos, isPredrop: boolean) {
    const drop = {
      role: role,
      pos: key
    };
    if (this.data.pref.submitMove && !isPredrop) {
      setTimeout(() => {
        backbutton.stack.push(this.cancelMove);
        this.vm.dropToSubmit = drop;
        redraw();
      }, this.data.pref.animationDuration || 0);
    } else socket.send('drop', drop, {
      ackable: true,
      withLag: !!this.clock
    });
  };

  this.cancelMove = function(fromBB?: string) {
    if (fromBB !== 'backbutton') backbutton.stack.pop();
    this.vm.moveToSubmit = null;
    this.vm.dropToSubmit = null;
    this.jump(this.vm.ply);
  }.bind(this);

  this.submitMove = function(v: boolean) {
    if (v && (this.vm.moveToSubmit || this.vm.dropToSubmit)) {
      if (this.vm.moveToSubmit) {
        socket.send('move', this.vm.moveToSubmit, {
          ackable: true
        });
      } else if (this.vm.dropToSubmit) {
        socket.send('drop', this.vm.dropToSubmit, {
          ackable: true
        });
      }
      if (this.data.game.speed === 'correspondence' && !hasNetwork()) {
        window.plugins.toast.show('You need to be connected to Internet to send your move.', 'short', 'center');
      }
      this.vm.moveToSubmit = null;
      this.vm.dropToSubmit = null;
    } else {
      this.cancelMove();
    }
  }.bind(this);

  const userMove = function(orig: Pos, dest: Pos, meta: any) {
    if (!promotion.start(this, orig, dest, meta.premove)) {
      this.sendMove(orig, dest, false, meta.premove);
    }
  }.bind(this);

  const onUserNewPiece = function(role: Role, key: Pos, meta: any) {
    if (!this.replaying() && crazyValid.drop(this.chessground, this.data, role, key, this.data.possibleDrops)) {
      this.sendNewPiece(role, key, meta.predrop);
    } else {
      this.jump(this.vm.ply);
    }
  }.bind(this);

  const onMove = function(orig: Pos, dest: Pos, capturedPiece: Piece) {
    if (capturedPiece) {
      if (this.data.game.variant.key === 'atomic') {
        atomic.capture(this.chessground, dest);
        sound.explosion();
      }
      else {
        sound.capture();
      }
    } else {
      sound.move();
    }

    if (!this.data.player.spectator) {
      vibrate.quick();
    }
  }.bind(this);

  const onNewPiece = function() {
    sound.move();
  };

  const playPredrop = function() {
    return this.chessground.playPredrop((drop: Drop) => {
      return crazyValid.drop(this.chessground, this.data, drop.role, drop.key, this.data.possibleDrops);
    });
  }.bind(this);

  this.apiMove = function(o: any) {
    const d = this.data;
    d.game.turns = o.ply;
    d.game.player = o.ply % 2 === 0 ? 'white' : 'black';
    const playedColor: Color = o.ply % 2 === 0 ? 'black' : 'white';
    if (o.status) {
      d.game.status = o.status;
    }
    if (o.winner) {
      d.game.winner = o.winner;
    }
    let wDraw = d[d.player.color === 'white' ? 'player' : 'opponent'].offeringDraw;
    let bDraw = d[d.player.color === 'black' ? 'player' : 'opponent'].offeringDraw;
    if (!wDraw && o.wDraw) {
      sound.dong();
      vibrate.quick();
    }
    if (!bDraw && o.bDraw) {
      sound.dong();
      vibrate.quick();
    }
    wDraw = o.wDraw;
    bDraw = o.bDraw;
    d.possibleMoves = d.player.color === d.game.player ? o.dests : null;
    d.possibleDrops = d.player.color === d.game.player ? o.drops : null;
    d.crazyhouse = o.crazyhouse;
    this.setTitle();

    if (!this.replaying()) {
      this.vm.ply++;

      const enpassantPieces: {[index:string]: Piece} = {};
      if (o.enpassant) {
        const p = o.enpassant;
        enpassantPieces[p.key] = null;
        if (d.game.variant.key === 'atomic') {
          atomic.enpassant(this.chessground, p.key, p.color);
        } else {
          sound.capture();
        }
      }

      const castlePieces: {[index:string]: Piece} = {};
      if (o.castle && !this.chessground.data.autoCastle) {
        const c = o.castle;
        castlePieces[c.king[0]] = null;
        castlePieces[c.rook[0]] = null;
        castlePieces[c.king[1]] = {
          role: 'king',
          color: c.color
        };
        castlePieces[c.rook[1]] = {
          role: 'rook',
          color: c.color
        };
      }

      const pieces = Object.assign({}, enpassantPieces, castlePieces);
      const newConf = {
        turnColor: d.game.player,
        movable: {
          dests: gameApi.isPlayerPlaying(d) ? gameApi.parsePossibleMoves(d.possibleMoves) : {}
        },
        check: o.check
      };
      if (o.isMove) {
        this.chessground.apiMove(
          o.uci.substr(0, 2),
          o.uci.substr(2, 2),
          pieces,
          newConf
        );
      } else {
        this.chessground.apiNewPiece(
          {
            role: o.role,
            color: playedColor
          },
          o.uci.substr(2, 2),
          newConf
        );
      }

      if (o.promotion) {
        ground.promote(this.chessground, o.promotion.key, o.promotion.pieceClass);
      }
    }

    if (o.clock) {
      const c = o.clock;
      if (this.clock) this.clock.update(c.white, c.black);
      else if (this.correspondenceClock) this.correspondenceClock.update(c.white, c.black);
    }

    d.game.threefold = !!o.threefold;
    d.steps.push({
      ply: round.lastPly(this.data) + 1,
      fen: o.fen,
      san: o.san,
      uci: o.uci,
      check: o.check,
      crazy: o.crazyhouse
    });
    gameApi.setOnGame(d, playedColor, true);

    if (!this.replaying() && playedColor !== d.player.color &&
      (this.chessground.data.premovable.current || this.chessground.data.predroppable.current.key)) {
      // atrocious hack to prevent race condition
      // with explosions and premoves
      // https://github.com/ornicar/lila/issues/343
      const premoveDelay = d.game.variant.key === 'atomic' ? 100 : 10;
      setTimeout(() => {
        this.chessground.playPremove();
        playPredrop();
      }, premoveDelay);
    }

    if (this.data.game.speed === 'correspondence') {
      session.refresh();
      saveOfflineGameData(vnode.attrs.id, this.data);
    }

  }.bind(this);

  const throttledBerserk = throttle(() => socket.send('berserk'), 500);
  this.goBerserk = function() {
    throttledBerserk();
    sound.berserk();
  };

  this.setBerserk = function(color: Color) {
    if (this.vm.goneBerserk[color]) return;
    this.vm.goneBerserk[color] = true;
    if (color !== this.data.player.color) sound.berserk();
    redraw();
  }.bind(this);

  this.chessground = ground.make(this.data, cfg.game.fen, userMove, onUserNewPiece, onMove, onNewPiece);

  this.clock = this.data.clock ? new clockCtrl(
    this.data.clock,
    this.data.player.spectator ? noop :
      throttle(() => socket.send('outoftime'), 500),
    this.data.player.spectator ? null : this.data.player.color
  ) : false;

  this.isClockRunning = function(): boolean {
    return this.data.clock && gameApi.playable(this.data) &&
      ((this.data.game.turns - this.data.game.startedAtTurn) > 1 || this.data.clock.running);
  }.bind(this);

  this.clockTick = function() {
    if (this.isClockRunning()) this.clock.tick(this.data.game.player);
  }.bind(this);

  const makeCorrespondenceClock = function() {
    if (this.data.correspondence && !this.correspondenceClock)
      this.correspondenceClock = new correspondenceClockCtrl(
        this,
        this.data.correspondence,
        () => socket.send('outoftime')
      );
  }.bind(this);
  makeCorrespondenceClock();

  const correspondenceClockTick = function() {
    if (this.correspondenceClock && gameApi.playable(this.data))
      this.correspondenceClock.tick(this.data.game.player);
  }.bind(this);

  let clockIntervId: number;
  if (this.clock) clockIntervId = setInterval(this.clockTick, 100);
  else if (this.correspondenceClock) clockIntervId = setInterval(correspondenceClockTick, 6000);

  this.chat = (session.isKidMode() || this.data.game.tournamentId || this.data.opponent.ai || this.data.player.spectator) ?
    null : chat.controller(this);

  this.notes = this.data.game.speed === 'correspondence' ? notes.controller(this) : null;

  this.reload = function(rCfg: GameData) {
    if (this.stepsHash(rCfg.steps) !== this.stepsHash(this.data.steps))
      this.vm.ply = rCfg.steps[rCfg.steps.length - 1].ply;
    if (this.chat) this.chat.onReload(rCfg.chat);
    if (this.data.tv) rCfg.tv = this.data.tv;
    if (this.data.userTV) rCfg.userTV = this.data.userTV;

    this.data = round.merge(this.data, rCfg).data;

    makeCorrespondenceClock();
    if (this.clock) this.clock.update(this.data.clock.white, this.data.clock.black);
    this.setTitle();
    if (!this.replaying()) ground.reload(this.chessground, this.data, rCfg.game.fen, this.vm.flip);
    redraw();
  }.bind(this);

  const reloadGameData = function() {
    xhr.reload(this).then(this.reload);
  }.bind(this);

  this.toggleBookmark = function() {
    return toggleGameBookmark(this.data.game.id).then(reloadGameData);
  }.bind(this);

  document.addEventListener('resume', reloadGameData);
  window.plugins.insomnia.keepAwake();

  this.unload = function() {
    clearInterval(clockIntervId);
    clearInterval(tournamentCountInterval);
    document.removeEventListener('resume', reloadGameData);
    signals.seekCanceled.remove(connectSocket);
    if (this.chat) this.chat.unload();
    if (this.notes) this.notes.unload();
  };
}