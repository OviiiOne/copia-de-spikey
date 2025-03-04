// Copyright 2018-2019 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (dev@campbellcrowley.com)
const http = require('http');
const socketIo = require('socket.io');
const auth = require('../../auth.js');
const crypto = require('crypto');
const HungryGames = require('../hg/HungryGames.js');

require('../subModule.js').extend(HGWeb);  // Extends the SubModule class.

/**
 * @classdesc Creates a web interface for managing the Hungry Games. Expects
 * ../hungryGames.js is loaded or will be loaded.
 * @class
 */
function HGWeb() {
  const self = this;
  this.myName = 'HGWeb';

  let hg_ = null;

  let ioClient;
  /**
   * Buffer storing all current image uploads and their associated meta-data.
   *
   * @private
   * @type {object}
   */
  const imageBuffer = {};

  const app = http.createServer(handler);
  let io;

  app.on('error', function(err) {
    if (io) io.close();
    if (app) app.close();
    if (err.code === 'EADDRINUSE') {
      self.warn(
          'HGWeb failed to bind to port because it is in use. (' + err.port +
          ')');
      startClient();
    } else {
      self.error('HGWeb failed to bind to port for unknown reason.', err);
    }
  });

  /**
   * Start a socketio client connection to the primary running server.
   *
   * @private
   */
  function startClient() {
    self.log(
        'Restarting into client mode due to server already bound to port.');
    ioClient = require('socket.io-client')(
        self.common.isRelease ? 'http://localhost:8011' :
                                'http://localhost:8013',
        {path: '/www.spikeybot.com/socket.io/hg/'});
    clientSocketConnection(ioClient);
  }

  /**
   * Update the reference to HungryGames.
   *
   * @private
   * @returns {HG} Reference to the currently loaded HungryGames subModule.
   */
  function hg() {
    const prev = hg_;
    hg_ = self.bot.getSubmodule('./hungryGames.js');
    if (!hg_) return;
    if (prev !== hg_) {
      unlinkHG();
      hg_.on('dayStateChange', dayStateChange);
      hg_.on('toggleOption', handleOptionChange);
      hg_.on('create', broadcastGame);
      hg_.on('refresh', broadcastGame);
      hg_.on('reset', broadcastGame);
      hg_.on('shutdown', unlinkHG);
    }
    return hg_;
  }

  /**
   * Unregister all event handlers from `hg_`.
   *
   * @private
   */
  function unlinkHG() {
    if (!hg_) return;
    hg_.removeListener('dayStateChange', dayStateChange);
    hg_.removeListener('toggleOption', handleOptionChange);
    hg_.removeListener('create', broadcastGame);
    hg_.removeListener('refresh', broadcastGame);
    hg_.removeListener('reset', broadcastGame);
    hg_.removeListener('shutdown', unlinkHG);
  }

  /** @inheritdoc */
  this.initialize = function() {
    io = socketIo(
        app, {path: '/www.spikeybot.com/socket.io/', serveClient: false});
    app.listen(self.common.isRelease ? 8011 : 8013, '127.0.0.1');
    io.on('connection', socketConnection);
  };

  /**
   * Causes a full shutdown of all servers.
   *
   * @public
   */
  this.shutdown = function() {
    if (io) io.close();
    if (ioClient) {
      ioClient.close();
      ioClient = null;
    }
    if (app) app.close();
    unlinkHG();
  };

  /**
   * Handler for all http requests. Should never be called.
   *
   * @private
   * @param {http.IncomingMessage} req The client's request.
   * @param {http.ServerResponse} res Our response to the client.
   */
  function handler(req, res) {
    res.writeHead(418);
    res.end('TEAPOT');
  }

  /**
   * Map of all currently connected sockets.
   *
   * @private
   * @type {object.<Socket>}
   */
  const sockets = {};

  /**
   * Returns the number of connected clients that are not siblings.
   *
   * @public
   * @returns {number} Number of sockets.
   */
  this.getNumClients = function() {
    return Object.keys(sockets).length - Object.keys(siblingSockets).length;
  };

  /**
   * Map of all sockets connected that are siblings.
   *
   * @private
   * @type {object.<Socket>}
   */
  const siblingSockets = {};

  /**
   * Handler for a new socket connecting.
   *
   * @private
   * @param {socketIo~Socket} socket The socket.io socket that connected.
   */
  function socketConnection(socket) {
    // x-forwarded-for is trusted because the last process this jumps through is
    // our local proxy.
    const ipName = self.common.getIPName(
        socket.handshake.headers['x-forwarded-for'] ||
        socket.handshake.address);
    self.common.log(
        'Socket connected (' + Object.keys(sockets).length + '): ' + ipName,
        socket.id);
    sockets[socket.id] = socket;

    // @TODO: Replace this authentication with gpg key-pairs;
    socket.on('vaderIAmYourSon', (verification, cb) => {
      if (verification === auth.hgWebSiblingVerification) {
        siblingSockets[socket.id] = socket;
        cb(auth.hgWebSiblingVerificationResponse);

        socket.on('_guildBroadcast', (gId, ...args) => {
          for (const i in sockets) {
            if (sockets[i] && sockets[i].cachedGuilds &&
                sockets[i].cachedGuilds.includes(gId)) {
              sockets[i].emit(...args);
            }
          }
        });
      } else {
        self.common.error('Client failed to authenticate as child.', socket.id);
      }
    });

    // Unrestricted Access //
    socket.on('fetchDefaultOptions', () => {
      socket.emit('defaultOptions', hg().defaultOptions.entries);
    });
    socket.on('fetchDefaultEvents', () => {
      socket.emit('defaultEvents', hg().getDefaultEvents());
    });
    // End Unrestricted Access \\

    // Restricted Access //
    socket.on('fetchGuilds', (...args) => handle(fetchGuilds, args, false));
    socket.on('fetchGuild', (...args) => handle(fetchGuild, args));
    socket.on('fetchMember', (...args) => handle(fetchMember, args));
    socket.on('fetchChannel', (...args) => handle(fetchChannel, args));
    socket.on('fetchGames', (...args) => handle(fetchGames, args));
    socket.on('fetchDay', (...args) => handle(fetchDay, args));
    socket.on('excludeMember', (...args) => handle(excludeMember, args));
    socket.on('includeMember', (...args) => handle(includeMember, args));
    socket.on('toggleOption', (...args) => handle(toggleOption, args));
    socket.on('createGame', (...args) => handle(createGame, args));
    socket.on('resetGame', (...args) => handle(resetGame, args));
    socket.on('startGame', (...args) => handle(startGame, args));
    socket.on('startAutoplay', (...args) => handle(startAutoplay, args));
    socket.on('nextDay', (...args) => handle(nextDay, args));
    socket.on('endGame', (...args) => handle(endGame, args));
    socket.on('pauseAutoplay', (...args) => handle(pauseAutoplay, args));
    socket.on('pauseGame', (...args) => handle(pauseGame, args));
    socket.on('editTeam', (...args) => handle(editTeam, args));
    socket.on('createEvent', (...args) => handle(createEvent, args));
    socket.on('createMajorEvent', (...args) => handle(createMajorEvent, args));
    socket.on('editMajorEvent', (...args) => handle(editMajorEvent, args));
    socket.on('removeEvent', (...args) => handle(removeEvent, args));
    socket.on('toggleEvent', (...args) => handle(toggleEvent, args));
    socket.on('forcePlayerState', (...args) => handle(forcePlayerState, args));
    socket.on('renameGame', (...args) => handle(renameGame, args));
    socket.on('removeNPC', (...args) => handle(removeNPC, args));
    socket.on(
        'fetchStatGroupList', (...args) => handle(fetchStatGroupList, args));
    socket.on(
        'fetchStatGroupMetadata',
        (...args) => handle(fetchStatGroupMetadata, args));
    socket.on('fetchStats', (...args) => handle(fetchStats, args));
    socket.on('fetchLeaderboard', (...args) => handle(fetchLeaderboard, args));
    socket.on('imageChunk', (...args) => handle(imageChunk, args));
    socket.on('imageInfo', (...args) => handle(imageInfo, args));
    // End Restricted Access \\

    /**
     * Calls the functions with added arguments, and copies the request to all
     * sibling clients.
     *
     * @private
     * @param {Function} func The function to call.
     * @param {Array.<*>} args Array of arguments to send to function.
     * @param {boolean} [forward=true] Forward this request directly to all
     * siblings.
     */
    function handle(func, args, forward = true) {
      const noLog = ['fetchMember', 'fetchChannel', 'imageChunk'];
      if (!noLog.includes(func.name.toString())) {
        const logArgs = args.map((el) => {
          if (typeof el === 'function') {
            return (el.name || 'cb') + '()';
          } else {
            return el;
          }
        });
        self.common.logDebug(`${func.name}(${logArgs.join(',')})`, socket.id);
      }
      let cb;
      if (typeof args[args.length - 1] === 'function') {
        const origCB = args[args.length - 1];
        let fired = false;
        cb = function(...args) {
          if (fired) {
            self.warn(
                'Attempting to fire callback a second time! (' + func.name +
                ')');
          }
          origCB(...args);
          fired = true;
        };
        args[args.length - 1] = cb;
      }
      func.apply(func, [args[0], socket].concat(args.slice(1)));
      if (typeof cb === 'function') {
        args[args.length - 1] = {_function: true};
      }
      if (forward) {
        Object.entries(siblingSockets).forEach((s) => {
          s[1].emit(
              'forwardedRequest', args[0], socket.id, func.name, args.slice(1),
              (res) => {
                if (res._forward) socket.emit(...res.data);
                if (res._callback && typeof cb === 'function') {
                  cb(...res.data);
                }
              });
        });
      }
    }

    socket.on('disconnect', () => {
      self.common.log(
          'Socket disconnected (' + (Object.keys(sockets).length - 1) + '): ' +
              ipName,
          socket.id);
      if (siblingSockets[socket.id]) delete siblingSockets[socket.id];
      delete sockets[socket.id];
    });
  }
  /**
   * Handler for connecting as a client to the server.
   *
   * @private
   * @param {socketIo~Socket} socket The socket.io socket that connected.
   */
  function clientSocketConnection(socket) {
    let authenticated = false;
    socket.on('connect', () => {
      socket.emit('vaderIAmYourSon', auth.hgWebSiblingVerification, (res) => {
        self.common.log('Sibling authenticated successfully.', socket.id);
        authenticated = res === auth.hgWebSiblingVerificationResponse;
      });
    });

    socket.on('fetchGuilds', (userData, id, cb) => {
      fetchGuilds(userData, {id: id}, cb);
    });

    socket.on('forwardedRequest', (userData, sId, func, args, cb) => {
      if (!authenticated) return;
      const fakeSocket = {
        fake: true,
        emit: function(...args) {
          if (typeof cb == 'function') cb({_forward: true, data: args});
        },
        id: sId,
      };
      if (args[args.length - 1]._function) {
        args[args.length - 1] = function(...a) {
          if (typeof cb === 'function') cb({_callback: true, data: a});
        };
      }
      if (!self[func]) {
        self.common.error(func + ': is not a function.', socket.id);
      } else {
        self[func].apply(self[func], [userData, fakeSocket].concat(args));
      }
    });
  }

  /**
   * This gets fired whenever the day state of any game changes in the hungry
   * games. This then notifies all clients that the state changed, if they care
   * about the guild.
   *
   * @private
   * @param {HungryGames} hg HG object firing the event.
   * @param {string} gId Guild id of the state change.
   * @listens HG#dayStateChange
   */
  function dayStateChange(hg, gId) {
    const game = hg.getHG().getGame(gId);
    let eventState = null;
    if (!game) return;
    if (game.currentGame.day.events[game.currentGame.day.state - 2] &&
        game.currentGame.day.events[game.currentGame.day.state - 2].battle) {
      eventState =
          game.currentGame.day.events[game.currentGame.day.state - 2].state;
    }
    guildBroadcast(
        gId, 'dayState', game.currentGame.day.num, game.currentGame.day.state,
        eventState);
  }

  /**
   * Broadcast a message to all relevant clients.
   *
   * @private
   * @param {string} gId Guild ID to broadcast message for.
   * @param {string} event The name of the event to broadcast.
   * @param {*} args Data to send in broadcast.
   */
  function guildBroadcast(gId, event, ...args) {
    const keys = Object.keys(sockets);
    for (const i in keys) {
      if (!sockets[keys[i]].cachedGuilds) continue;
      if (sockets[keys[i]].cachedGuilds.find((g) => g === gId)) {
        sockets[keys[i]].emit(event, gId, ...args);
      }
    }
    if (ioClient) {
      ioClient.emit('_guildBroadcast', gId, event, gId, ...args);
    }
  }

  /**
   * Handles an option being changed and broadcasting the update to clients.
   *
   * @private
   * @listens HG#toggleOption
   * @param {HungryGames} hg HG object firing the event.
   * @param {string} gId Guild ID of the option change.
   * @param {string} opt1 Option key.
   * @param {string} opt2 Option second key or value.
   * // @param {string} [opt3] Option value if object option.
   */
  function handleOptionChange(hg, gId, opt1, opt2) {
    if (opt1 === 'teamSize') {
      broadcastGame(hg, gId);
    } else {
      guildBroadcast(gId, 'option', opt1, opt2);
    }
  }

  /**
   * Handles broadcasting the game data to all relevant clients.
   *
   * @private
   * @listens HG#create
   * @listens HG#refresh
   * @param {HungryGames} hg HG object firing event.
   * @param {string} gId The guild ID to data for.
   */
  function broadcastGame(hg, gId) {
    const game = hg.getHG().getGame(gId);
    guildBroadcast(gId, 'game', game && game.serializable);
  }

  /**
   * Send a message to the given socket informing the client that the command
   * they attempted failed due to insufficient permission.
   *
   * @private
   * @param {Socket} socket The socket.io socket to reply on.
   * @param {string} cmd THe command the client attempted.
   */
  function replyNoPerm(socket, cmd) {
    self.common.logDebug(
        'Attempted ' + cmd + ' without permission.', socket.id);
    socket.emit(
        'message', 'Failed to run command "' + cmd +
            '" because you don\'t have permission for this.');
  }

  /**
   * Checks if the current shard is responsible for the requested guild.
   *
   * @private
   * @param {number|string} gId The guild id to check.
   * @returns {boolean} True if this shard has this guild.
   */
  function checkMyGuild(gId) {
    const g = self.client.guilds.get(gId);
    return (g && true) || false;
  }

  /**
   * Check that the given user has permission to manage the games in the given
   * guild.
   *
   * @private
   * @param {UserData} userData The user to check.
   * @param {string} gId The guild id to check against.
   * @param {?string} cId The channel id to check against.
   * @param {string} cmd The command being attempted.
   * @returns {boolean} Whther the user has permission or not to manage the
   * hungry games in the given guild.
   */
  function checkPerm(userData, gId, cId, cmd) {
    if (!userData) return false;
    const msg = makeMessage(userData.id, gId, cId, 'hg ' + cmd);
    if (!msg || !msg.author) return false;
    if (userData.id == self.common.spikeyId) return true;
    return !self.command.validate(null, msg);
  }

  /**
   * Check that the given user has permission to see and send messages in the
   * given channel, as well as manage the games in the given guild.
   *
   * @private
   * @param {UserData} userData The user to check.
   * @param {string} gId The guild id of the guild that contains the channel.
   * @param {string} cId The channel id to check against.
   * @param {string} cmd The command being attempted to check permisisons for.
   * @returns {boolean} Whther the user has permission or not to manage the
   * hungry games in the given guild and has permission to send messages in the
   * given channel.
   */
  function checkChannelPerm(userData, gId, cId, cmd) {
    if (!checkPerm(userData, gId, cId, cmd)) return false;
    if (userData.id == self.common.spikeyId) return true;
    const g = self.client.guilds.get(gId);

    const channel = g.channels.get(cId);
    if (!channel) return false;

    const m = g.members.get(userData.id);

    const perms = channel.permissionsFor(m);
    if (!perms.has(self.Discord.Permissions.FLAGS.VIEW_CHANNEL)) return false;
    if (!perms.has(self.Discord.Permissions.FLAGS.SEND_MESSAGES)) return false;
    return true;
  }

  /**
   * Forms a Discord~Message similar object from given IDs.
   *
   * @private
   * @param {string} uId The id of the user who wrote this message.
   * @param {string} gId The id of the guild this message is in.
   * @param {?string} cId The id of the channel this message was 'sent' in.
   * @param {?string} msg The message content.
   * @returns {
   *   {
   *     author: Discord~User,
   *     member: Discord~GuildMember,
   *     guild: Discord~Guild,
   *     channel: Discord~GuildChannel,
   *     text: string,
   *     content: string,
   *     prefix: string
   *   }
   * } The created message-like object.
   */
  function makeMessage(uId, gId, cId, msg) {
    const g = self.client.guilds.get(gId);
    if (!g) return null;
    const prefix = self.bot.getPrefix(gId);
    return {
      member: g.members.get(uId),
      author: self.client.users.get(uId),
      guild: g,
      channel: g.channels.get(cId),
      text: msg,
      content: `${prefix}${msg}`,
      prefix: prefix,
    };
  }

  /**
   * Strips a Discord~GuildMember to only the necessary data that a client will
   * need.
   *
   * @private
   * @param {Discord~GuildMember} m The guild member to strip the data from.
   * @returns {object} The minimal member.
   */
  function makeMember(m) {
    if (typeof m !== 'object') {
      m = {
        roles: {
          array: function() {
            return [];
          },
        },
        guild: {},
        permissions: {bitfield: 0},
        user: self.client.users.get(m),
      };
    }
    return {
      nickname: m.nickname,
      roles: m.roles.array(),
      color: m.displayColor,
      guild: {id: m.guild.id},
      permissions: m.permissions.bitfield,
      user: {
        username: m.user.username,
        avatarURL: m.user.displayAvatarURL(),
        id: m.user.id,
        bot: m.user.bot,
        // m.user.descriminator seems to be broken and always returns
        // `undefined`.
        descriminator: m.user.tag.match(/#(\d{4})$/)[1],
      },
      joinedTimestamp: m.joinedTimestamp,
    };
  }

  /**
   * Cancel and clean up a current image upload.
   *
   * @private
   * @param {string} iId Image upload ID to purge and abort.
   */
  function cancelImageUpload(iId) {
    if (!imageBuffer[iId]) return;
    clearTimeout(imageBuffer[iId].timeout);
    delete imageBuffer[iId];
  }

  /**
   * Create an upload ID and buffer for a client to send to. Automatically
   * cancelled after 60 seconds.
   *
   * @private
   * @param {string} uId The user ID that started this upload.
   * @returns {object} The metadata storing object.
   */
  function beginImageUpload(uId) {
    let id;
    do {
      id = `${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    } while (imageBuffer[id]);
    imageBuffer[id] =
        {receivedBytes: 0, buffer: [], startTime: Date.now(), id: id, uId: uId};
    imageBuffer[id].timeout = setTimeout(function() {
      cancelImageUpload(id);
    }, 60000);
    return imageBuffer[id];
  }

  /**
   * Basic callback with single argument. The argument is null if there is no
   * error, or a string if there was an error.
   *
   * @callback HGWeb~basicCB
   *
   * @param {?string} err The error response.
   */

  /**
   * Fetch all relevant data for all mutual guilds with the user and send it to
   * the user.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchGuilds(userData, socket, cb) {
    if (!userData) {
      self.common.error('Fetch Guilds without userData', socket.id);
      if (typeof cb === 'function') cb('SIGNED_OUT');
      return;
    }

    const numReplies = (Object.entries(siblingSockets).length || 0);
    let replied = 0;
    const guildBuffer = {};
    let done;
    if (typeof cb === 'function') {
      done = cb;
    } else {
      /**
       * The callback for each response with the requested data. Replies to the
       * user once all requests have replied.
       *
       * @private
       * @param {string|object} guilds Either the guild data to send to the
       * user, or 'guilds' if this is a reply from a sibling client.
       * @param {?string} [err] The error that occurred, or null if no error.
       * @param {object} [response] The guild data if `guilds` equals 'guilds'.
       */
      done = function(guilds, err, response) {
        if (guilds === 'guilds') {
          if (err) {
            guilds = null;
          } else {
            guilds = response;
          }
        }
        for (let i = 0; guilds && i < guilds.length; i++) {
          guildBuffer[guilds[i].id] = guilds[i];
        }
        replied++;
        if (replied > numReplies) {
          if (typeof cb === 'function') cb(guildBuffer);
          socket.emit('guilds', null, guildBuffer);
          socket.cachedGuilds = Object.keys(guildBuffer || {});
        }
      };
    }
    Object.entries(siblingSockets).forEach((obj) => {
      obj[1].emit('fetchGuilds', userData, socket.id, done);
    });

    try {
      let guilds = [];
      if (userData.guilds && userData.guilds.length > 0) {
        userData.guilds.forEach((el) => {
          const g = self.client.guilds.get(el.id);
          if (!g) return;
          guilds.push(g);
        });
      } else {
        guilds = self.client.guilds
            .filter((obj) => {
              return obj.members.get(userData.id);
            })
            .array();
      }
      const strippedGuilds = stripGuilds(guilds, userData);
      done(strippedGuilds);
    } catch (err) {
      self.common.error(
          'Error while fetching guilds (Cached: ' +
              (userData.guilds && true || false) + ')',
          socket.id);
      console.error(err);
      done();
    }
  }
  this.fetchGuilds = fetchGuilds;

  /**
   * Strip a Discord~Guild to the basic information the client will need.
   *
   * @private
   * @param {Discord~Guild[]} guilds The array of guilds to strip.
   * @param {object} userData The current user's session data.
   * @returns {Array<object>} The stripped guilds.
   */
  function stripGuilds(guilds, userData) {
    return guilds.map((g) => {
      let dOpts = self.command.getDefaultSettings() || {};
      dOpts = Object.entries(dOpts)
          .filter((el) => {
            return el[1].getFullName().startsWith('hg');
          })
          .reduce(
              (p, c) => {
                p[c[0]] = c[1];
                return p;
              },
              {});
      let uOpts = self.command.getUserSettings(g.id) || {};
      uOpts = Object.entries(uOpts)
          .filter((el) => {
            return el[0].startsWith('hg');
          })
          .reduce(
              (p, c) => {
                p[c[0]] = c[1];
                return p;
              },
              {});

      const member = g.members.get(userData.id);
      const newG = {};
      newG.iconURL = g.iconURL();
      newG.name = g.name;
      newG.id = g.id;
      newG.bot = self.client.user.id;
      newG.ownerId = g.ownerID;
      newG.members = g.members.map((m) => {
        return m.id;
      });
      newG.defaultSettings = dOpts;
      newG.userSettings = uOpts;
      newG.channels =
          g.channels
              .filter((c) => {
                return userData.id == self.common.spikeyId ||
                    c.permissionsFor(member).has(
                        self.Discord.Permissions.FLAGS.VIEW_CHANNEL);
              })
              .map((c) => {
                return {
                  id: c.id,
                  permissions: userData.id == self.common.spikeyId ?
                      self.Discord.Permissions.ALL :
                      c.permissionsFor(member).bitfield,
                };
              });
      newG.myself = makeMember(member || userData.id);
      return newG;
    });
  }

  /**
   * Fetch a single guild.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string|number} gId The ID of the guild that was requested.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchGuild(userData, socket, gId, cb) {
    if (!userData) {
      self.common.error('Fetch Guild without userData', socket.id);
      if (typeof cb === 'function') cb('SIGNED_OUT');
      return;
    }
    if (typeof cb !== 'function') {
      self.common.logWarning(
          'Fetch Guild attempted without callback', socket.id);
      return;
    }

    const guild = self.client.guilds.get(gId);
    if (!guild) {
      return;
    }
    if (userData.id != self.common.spikeyId &&
        !guild.members.get(userData.id)) {
      cb(null);
      return;
    }
    cb(stripGuilds([guild], userData)[0]);
  }
  this.fetchGuild = fetchGuild;
  /**
   * Fetch data about a member of a guild.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {number|string} mId The member's id to lookup.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchMember(userData, socket, gId, mId, cb) {
    if (!checkPerm(userData, gId, null, 'players')) return;
    const g = self.client.guilds.get(gId);
    if (!g) return;
    const m = g.members.get(mId);
    if (!m) return;
    const finalMember = makeMember(m);

    if (typeof cb === 'function') {
      cb(null, finalMember);
    } else {
      socket.emit('member', gId, mId, finalMember);
    }
  }
  this.fetchMember = fetchMember;
  /**
   * Fetch data about a channel of a guild.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {number|string} cId The channel's id to lookup.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchChannel(userData, socket, gId, cId, cb) {
    if (!checkChannelPerm(userData, gId, cId, '')) return;
    const g = self.client.guilds.get(gId);
    if (!g) return;
    const m = g.members.get(userData.id);
    const channel = g.channels.get(cId);

    const perms = channel.permissionsFor(m) || {bitfield: 0};

    const stripped = {};
    stripped.id = channel.id;
    stripped.permissions = perms.bitfield;
    stripped.name = channel.name;
    stripped.position = channel.position;
    if (channel.parent) stripped.parent = {position: channel.parent.position};
    stripped.type = channel.type;

    if (typeof cb === 'function') {
      cb(null, stripped);
    } else {
      socket.emit('channel', gId, cId, stripped);
    }
  }
  this.fetchChannel = fetchChannel;
  /**
   * Fetch all game data within a guild.
   *
   * @see {@link HungryGames.getGame}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchGames(userData, socket, gId, cb) {
    if (!checkPerm(userData, gId, null, 'options') ||
        !checkPerm(userData, gId, null, 'players')) {
      if (!checkMyGuild(gId)) return;
      replyNoPerm(socket, 'fetchGames');
      return;
    }

    const game = hg().getHG().getGame(gId);
    if (typeof cb === 'function') {
      cb(null, game && game.serializable);
    } else {
      socket.emit('game', gId, game && game.serializable);
    }
  }
  this.fetchGames = fetchGames;
  /**
   * Fetch the updated game's day information.
   *
   * @see {@link HungryGames.getGame}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchDay(userData, socket, gId, cb) {
    let g; let m;
    if (!userData) {
      return;
    } else {
      g = self.client.guilds.get(gId);
      if (!g) {
        // Request is probably fulfilled by another sibling.
        return;
      } else {
        m = g.members.get(userData.id);
        if (!m) {
          self.common.log(
              'Attempted fetchDay, but unable to find member in guild' + gId +
                  '@' + userData.id,
              socket.id);
          return;
        }
      }
    }
    const game = hg().getHG().getGame(gId);
    if (!game || !game.currentGame || !game.currentGame.day) {
      if (typeof cb === 'function') {
        cb('NO_GAME_IN_GUILD');
      } else {
        socket.emit(
            'message',
            'There doesn\'t appear to be a game on this server yet.');
      }
      return;
    }

    if (!g.channels.get(game.outputChannel)
        .permissionsFor(m)
        .has(self.Discord.Permissions.FLAGS.VIEW_CHANNEL)) {
      replyNoPerm(socket, 'fetchDay');
      return;
    }

    if (typeof cb === 'function') {
      cb(null, game.currentGame.day, game.currentGame.includedUsers);
    } else {
      socket.emit(
          'day', gId, game.currentGame.day, game.currentGame.includedUsers);
    }
  }
  this.fetchDay = fetchDay;
  /**
   * Exclude a member from the Games.
   *
   * @see {@link HungryGames.excludeUsers}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {number|string} mId The member id to exclude.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function excludeMember(userData, socket, gId, mId, cb) {
    if (!checkPerm(userData, gId, null, 'exclude')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'excludeMember');
      return;
    }
    if (mId === 'everyone' || mId === 'online' || mId == 'offline' ||
        mId == 'dnd' || mId == 'idle') {
      hg().excludeUsers(mId, gId, (res) => {
        if (typeof cb === 'function') cb(res);
      });
    } else {
      hg().excludeUsers([mId], gId, (res) => {
        if (typeof cb === 'function') cb(res);
      });
    }
  }
  this.excludeMember = excludeMember;
  /**
   * Include a member in the Games.
   *
   * @see {@link HungryGames.includeUsers}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {number|string} mId The member id to include.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function includeMember(userData, socket, gId, mId, cb) {
    if (!checkPerm(userData, gId, null, 'include')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'includeMember');
      return;
    }
    if (mId === 'everyone' || mId === 'online' || mId == 'offline' ||
        mId == 'dnd' || mId == 'idle') {
      hg().includeUsers(mId, gId, (res) => {
        if (typeof cb === 'function') cb(res);
      });
    } else {
      hg().includeUsers([mId], gId, (res) => {
        if (typeof cb === 'function') cb(res);
      });
    }
  }
  this.includeMember = includeMember;
  /**
   * Toggle an option in the Games.
   *
   * @see {@link HungryGames.setOption}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {string} option The option to change.
   * @param {string|number} value The value to set option to.
   * @param {string} extra The extra text if the option is in an object.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function toggleOption(userData, socket, gId, option, value, extra, cb) {
    if (!checkPerm(userData, gId, null, 'option')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'toggleOption');
      return;
    }
    const response = hg().setOption(gId, option, value, extra || undefined);
    const game = hg().getHG().getGame(gId);
    if (typeof cb === 'function') {
      cb(null, response, game && game.options[option],
          game && game.serializable);
    } else {
      if (!game) {
        socket.emit('message', response);
      }
    }
  }
  this.toggleOption = toggleOption;
  /**
   * Create a Game.
   *
   * @see {@link HungryGames.createGame}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function createGame(userData, socket, gId, cb) {
    if (!checkPerm(userData, gId, null, 'create')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'createGame');
      return;
    }
    hg().createGame(gId, (game) => {
      if (typeof cb === 'function') {
        cb(game ? null : 'ATTEMPT_FAILED', game && game.serializable);
      }
    });
  }
  this.createGame = createGame;
  /**
   * Reset game data.
   *
   * @see {@link HungryGames.resetGame}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {string} cmd Command specifying what data to delete.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function resetGame(userData, socket, gId, cmd, cb) {
    if (!checkPerm(userData, gId, null, 'reset')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'resetGame');
      return;
    }
    const response = hg().getHG().resetGame(gId, cmd);
    const game = hg().getHG().getGame(gId);
    if (typeof cb === 'function') {
      cb(null, response, game && game.serializable);
    }
  }
  this.resetGame = resetGame;
  /**
   * Start the game.
   *
   * @see {@link HungryGames.startGame}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {number|string} cId Channel to start the game in.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function startGame(userData, socket, gId, cId, cb) {
    if (!checkChannelPerm(userData, gId, cId, 'start')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'startGame');
      return;
    }
    hg().startGame(userData.id, gId, cId);
    const game = hg().getHG().getGame(gId);
    if (typeof cb === 'function') {
      cb(null, game && game.serializable);
    } else {
      socket.emit('game', gId, game && game.serializable);
    }
  }
  this.startGame = startGame;
  /**
   * Enable autoplay.
   *
   * @see {@link HungryGames.startAutoplay}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {number|string} cId Channel to send the messages in.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function startAutoplay(userData, socket, gId, cId, cb) {
    if (!checkChannelPerm(userData, gId, cId, 'autoplay')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'startAutoplay');
      return;
    }
    hg().startAutoplay(userData.id, gId, cId);
    const game = hg().getHG().getGame(gId);
    if (typeof cb === 'function') {
      cb(null, game && game.serializable);
    } else {
      socket.emit('game', gId, game && game.serializable);
    }
  }
  this.startAutoplay = startAutoplay;
  /**
   * Start the next day.
   *
   * @see {@link HungryGames.nextDay}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {number|string} cId Channel to send the messages in.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function nextDay(userData, socket, gId, cId, cb) {
    if (!checkChannelPerm(userData, gId, cId, 'next')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'nextDay');
      return;
    }
    hg().nextDay(userData.id, gId, cId);
    const game = hg().getHG().getGame(gId);
    if (typeof cb === 'function') {
      cb(null, game && game.serializable);
    } else {
      socket.emit('game', gId, game && game.serializable);
    }
  }
  this.nextDay = nextDay;
  /**
   * End the game.
   *
   * @see {@link HungryGames.endGame}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function endGame(userData, socket, gId, cb) {
    if (!checkPerm(userData, gId, null, 'end')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'endGame');
      return;
    }
    hg().endGame(userData.id, gId);
    const game = hg().getHG().getGame(gId);
    if (typeof cb === 'function') {
      cb(null, game && game.serializable);
    } else {
      socket.emit('game', gId, game && game.serializable);
    }
  }
  this.endGame = endGame;
  /**
   * Disable autoplay.
   *
   * @see {@link HungryGames.pauseAutoplay}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function pauseAutoplay(userData, socket, gId, cb) {
    if (!checkPerm(userData, gId, null, 'autoplay')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'pauseAutoplay');
      return;
    }
    hg().pauseAutoplay(userData.id, gId);
    const game = hg().getHG().getGame(gId);
    if (typeof cb === 'function') {
      cb(null, game && game.serializable);
    } else {
      socket.emit('game', gId, game && game.serializable);
    }
  }
  this.pauseAutoplay = pauseAutoplay;
  /**
   * Pause game.
   *
   * @see {@link HungryGames.pauseGame}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function pauseGame(userData, socket, gId, cb) {
    if (!checkPerm(userData, gId, null, 'pause')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'pauseGame');
      return;
    }
    const error = hg().pauseGame(gId);
    const game = hg().getHG().getGame(gId);
    if (typeof cb === 'function') {
      if (error !== 'Success') {
        cb(error);
      } else {
        cb(null, game && game.serializable);
      }
    } else {
      if (error !== 'Success') {
        socket.emit('message', error);
      } else {
        socket.emit('game', gId, game && game.serializable);
      }
    }
  }
  this.pauseGame = pauseGame;
  /**
   * Edit the teams.
   *
   * @see {@link HungryGames.editTeam}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {string} cmd The command to run.
   * @param {string} one The first argument.
   * @param {string} two The second argument.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function editTeam(userData, socket, gId, cmd, one, two, cb) {
    if (!checkPerm(userData, gId, null, 'team')) {
      if (!checkMyGuild(gId)) return;
      replyNoPerm(socket, 'editTeam');
      return;
    }
    const message = hg().editTeam(userData.id, gId, cmd, one, two);
    if (typeof cb === 'function') {
      cb(null, message);
    } else {
      if (message) socket.emit('message', message);
    }
  }
  this.editTeam = editTeam;
  /**
   * Create a game event.
   *
   * @see {@link HungryGames.createEvent}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {string} type The type of event.
   * @param {string} message The message of the event.
   * @param {string} nV Number of victims.
   * @param {string} nA Number of attackers.
   * @param {string} oV Outcome of victims.
   * @param {string} oA Outcome of attackers.
   * @param {string} kV Do the victims kill.
   * @param {string} kA Do the attackers kill.
   * @param {?object} wV The weapon information for this event.
   * @param {?object} wA The weapon information for this event.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function createEvent(
      userData, socket, gId, type, message, nV, nA, oV, oA, kV, kA, wV, wA,
      cb) {
    if (!checkPerm(userData, gId, null, 'event')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'createEvent');
      return;
    }
    const err = hg().makeAndAddEvent(
        gId, type, message, nV, nA, oV, oA, kV, kA, wV, wA);
    if (err) {
      if (typeof cb === 'function') {
        cb('ATTEMPT_FAILED');
      } else {
        socket.emit('message', 'Failed to create event: ' + err);
      }
    } else {
      const game = hg().getHG().getGame(gId);
      if (typeof cb === 'function') {
        if (game) {
          cb(null, game.serializable);
        } else {
          cb();
        }
      } else if (game) {
        socket.emit('game', gId, game.serializable);
      }
    }
  }
  this.createEvent = createEvent;

  /**
   * Create a larger game event. Either Arena or Weapon at this point. If
   * message or weapon name already exists, this will instead edit the event.
   *
   * @see {@link HungryGames.addMajorEvent}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {string} type The type of event.
   * @param {HungryGames~ArenaEvent|HungryGames~WeaponEvent} data The event
   * data.
   * @param {?string} name The name of the weapon if this is a weapon event.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function createMajorEvent(userData, socket, gId, type, data, name, cb) {
    if (!checkPerm(userData, gId, null, 'event')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'createMajorEvent');
      return;
    }
    const err = hg().addMajorEvent(gId, type, data, name);
    if (err) {
      if (typeof cb === 'function') {
        cb('ATTEMPT_FAILED');
      } else {
        socket.emit('message', 'Failed to create event: ' + err);
      }
    } else {
      const game = hg().getHG().getGame(gId);
      if (typeof cb === 'function') {
        if (game) {
          cb(null, game.serializable);
        } else {
          cb();
        }
      } else if (game) {
        socket.emit('game', gId, game.serializable);
      }
    }
  }
  this.createMajorEvent = createMajorEvent;

  /**
   * Delete a larger game event. Either Arena or Weapon at this point.
   *
   * @see {@link HungryGames.editMajorEvent}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {string} type The type of event.
   * @param {HungryGames~ArenaEvent|HungryGames~WeaponEvent} search The event
   * data to find to edit.
   * @param {HungryGames~ArenaEvent|HungryGames~WeaponEvent} data The event
   * data to set the matched searches to.
   * @param {?string} name The internal name of the weapon to find.
   * @param {?string} newName The new internal name of the weapon.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function editMajorEvent(
      userData, socket, gId, type, search, data, name, newName, cb) {
    if (!checkPerm(userData, gId, null, 'event')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'removeMajorEvent');
      return;
    }
    const err = hg().editMajorEvent(gId, type, search, data, name, newName);
    if (err) {
      if (typeof cb === 'function') {
        cb('ATTEMPT_FAILED');
      } else {
        socket.emit('message', 'Failed to edit event: ' + err);
      }
    } else {
      const game = hg().getHG().getGame(gId);
      if (typeof cb === 'function') {
        if (game) {
          cb(null, game.serializable);
        } else {
          cb();
        }
      } else if (game) {
        socket.emit('game', gId, game.serializable);
      }
    }
  }
  this.editMajorEvent = editMajorEvent;

  /**
   * Remove a game event.
   *
   * @see {@link HungryGames.removeEvent}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {string} type The type of event.
   * @param {HungryGames~Event} event The game event to remove.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function removeEvent(userData, socket, gId, type, event, cb) {
    if (!checkPerm(userData, gId, null, 'event')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'removeEvent');
      return;
    }
    const err = hg().removeEvent(gId, type, event);
    if (err) {
      if (typeof cb === 'function') {
        cb('ATTEMPT_FAILED');
      } else {
        socket.emit('message', 'Failed to remove event: ' + err);
      }
    } else {
      const game = hg().getHG().getGame(gId);
      if (typeof cb === 'function') {
        if (game) {
          cb(null, game.serializable);
        } else {
          cb();
        }
      } else if (game) {
        socket.emit('game', gId, game.serializable);
      }
    }
  }
  this.removeEvent = removeEvent;

  /**
   * @description Enable or disable an event without deleting it.
   * @see {@link HungryGames.toggleEvent}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo-Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to run this command on.
   * @param {string} type The type of event that we are toggling.
   * @param {?string} subCat The subcategory if necessary.
   * @param {
   * HungryGames~Event|
   * HungryGames~ArenaEvent|
   * HungryGames~WeaponEvent
   * } event The event to toggle.
   * @param {?boolean} value Set the enabled value instead of toggling.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete.
   */
  function toggleEvent(userData, socket, gId, type, subCat, event, value, cb) {
    if (!checkPerm(userData, gId, null, 'event')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'removeEvent');
      return;
    }
    const err = hg().toggleEvent(gId, type, subCat, event, value);
    if (err) {
      if (typeof cb === 'function') {
        cb('ATTEMPT_FAILED');
      } else {
        socket.emit('message', 'Failed to toggle event: ' + err);
      }
    } else {
      if (typeof cb === 'function') cb();
      // socket.emit('message', 'Toggled event.');
      // socket.emit('game', gId, hg().getHG().getGame(gId));
    }
  }
  this.toggleEvent = toggleEvent;

  /**
   * Force a player in the game to end a day in a certain state.
   *
   * @see {@link HungryGames.forcePlayerState}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo-Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to run this command on.
   * @param {string[]} list The list of user IDs of the players to effect.
   * @param {string} state The forced state.
   * @param {string} [text] The message to show in the games as a result of this
   * command.
   * @param {boolean} [persists] Will this state be forced until the game ends.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete.
   */
  function forcePlayerState(
      userData, socket, gId, list, state, text, persists, cb) {
    let cmdToCheck = state;
    switch (state) {
      case 'living':
      case 'thriving':
        cmdToCheck = 'heal';
        break;
      case 'dead':
        cmdToCheck = 'kill';
        break;
      case 'wounded':
        cmdToCheck = 'hurt';
        break;
    }
    if (!checkPerm(userData, gId, null, cmdToCheck)) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'forcePlayerState');
      return;
    }
    const game = hg().getHG().getGame(gId);
    if (!game) return;
    if (typeof text != 'string') text = hg().getHG()._defaultPlayerEvents;
    const response = HungryGames.GuildGame.forcePlayerState(
        game, list, state, hg().getHG().messages, text, persists);
    if (typeof cb === 'function') {
      cb(null, response, game.serializable);
    } else {
      socket.emit('message', response);
    }
  }
  this.forcePlayerState = forcePlayerState;

  /**
   * Rename the guild's game.
   *
   * @see {@link HungryGames.renameGame}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo-Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to run this command on.
   * @param {string} name The name to change the game to.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete.
   */
  function renameGame(userData, socket, gId, name, cb) {
    if (!checkPerm(userData, gId, null, 'rename')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'renameGame');
      return;
    }
    hg().renameGame(gId, name);
    if (typeof cb === 'function') {
      let name = null;
      let game = hg().getHG().getGame(gId);
      if (game) game = game.currentGame;
      if (game) name = game.name;
      cb(name);
    }
  }
  this.renameGame = renameGame;

  /**
   * Remove an NPC from a game.
   *
   * @see {@link HungryGames.removeNPC}
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo-Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to run this command on.
   * @param {string} npcId The ID of the NPC to remove.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete.
   */
  function removeNPC(userData, socket, gId, npcId, cb) {
    if (!checkPerm(userData, gId, null, 'ai remove')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'removeNPC');
      return;
    }
    const error = hg().removeNPC(gId, npcId);
    if (typeof cb === 'function') {
      cb(typeof error === 'string' ? error : null);
    }
  }
  this.removeNPC = removeNPC;

  /**
   * Respond with list of stat groups for the requested guild.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchStatGroupList(userData, socket, gId, cb) {
    if (!checkPerm(userData, gId, null, 'groups')) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'groups');
      return;
    }
    const game = hg().getHG().getGame(gId);
    if (!game) {
      if (typeof cb === 'function') cb('NO_GAME_IN_GUILD');
      return;
    }
    game._stats.fetchGroupList((err, list) => {
      if (err) {
        if (err.code === 'ENOENT') {
          list = [];
        } else {
          self.error('Failed to get list of stat groups.');
          console.error(err);
          if (typeof cb === 'function') cb('ATTEMPT_FAILED');
          return;
        }
      }
      if (typeof cb === 'function') {
        cb(null, list);
      } else {
        socket.emit('statGroupList', gId, list);
      }
    });
  }
  this.fetchStatGroupList = fetchStatGroupList;

  /**
   * Respond with metadata for the requested stat group.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} guildId The guild id to look at.
   * @param {string} groupId The ID of the group.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchStatGroupMetadata(userData, socket, guildId, groupId, cb) {
    if (!checkPerm(userData, guildId, null, 'groups')) {
      if (!checkMyGuild(guildId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'groups');
      return;
    }
    const game = hg().getHG().getGame(guildId);
    if (!game) {
      if (typeof cb === 'function') cb('NO_GAME_IN_GUILD');
      return;
    }
    game._stats.fetchGroup(groupId, (err, group) => {
      if (err) {
        if (typeof cb === 'function') cb('BAD_GROUP');
        return;
      }
      group.fetchMetadata((err, meta) => {
        if (err) {
          self.error(
              'Failed to fetch metadata for stat group: ' + guildId + '/' +
              group.id);
          console.error(err);
          if (typeof cb === 'function') cb('ATTEMPT_FAILED');
          return;
        }
        if (typeof cb === 'function') {
          cb(null, meta);
        } else {
          socket.emit('statGroupMetadata', guildId, groupId, meta);
        }
      });
    });
  }
  this.fetchStatGroupMetadata = fetchStatGroupMetadata;

  /**
   * Respond with stats for a specific user in a group.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} guildId The guild id to look at.
   * @param {string} groupId The ID of the group.
   * @param {string} userId The ID of the user.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchStats(userData, socket, guildId, groupId, userId, cb) {
    if (!checkPerm(userData, guildId, null, 'stats')) {
      if (!checkMyGuild(guildId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'stats');
      return;
    }
    const game = hg().getHG().getGame(guildId);
    if (!game) {
      if (typeof cb === 'function') cb('NO_GAME_IN_GUILD');
      return;
    }
    game._stats.fetchGroup(groupId, (err, group) => {
      if (err) {
        if (typeof cb === 'function') cb('BAD_GROUP');
        return;
      }
      group.fetchUser(userId, (err, data) => {
        if (err) {
          self.error(
              'Failed to fetch user stats: ' + guildId + '@' + userId + '/' +
              group.id);
          console.error(err);
          if (typeof cb === 'function') cb('ATTEMPT_FAILED');
          return;
        }
        if (typeof cb === 'function') {
          cb(null, data.serializable);
        } else {
          socket.emit('userStats', guildId, groupId, userId, data.serializable);
        }
      });
    });
  }
  this.fetchStats = fetchStats;

  /**
   * Respond with leaderboard information.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} guildId The guild id to look at.
   * @param {string} groupId The ID of the group.
   * @param {HGStatGroupUserSelectOptions} opt Data select options.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchLeaderboard(userData, socket, guildId, groupId, opt, cb) {
    if (!checkPerm(userData, guildId, null, 'stats')) {
      if (!checkMyGuild(guildId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'stats');
      return;
    }
    const game = hg().getHG().getGame(guildId);
    if (!game) {
      if (typeof cb === 'function') cb('NO_GAME_IN_GUILD');
      return;
    }
    game._stats.fetchGroup(groupId, (err, group) => {
      if (err) {
        if (typeof cb === 'function') cb('BAD_GROUP');
        return;
      }
      group.fetchUsers(opt, (err, rows) => {
        if (err) {
          self.error(
              'Failed to fetch leaderboard: ' + guildId + '/' + group.id);
          console.error(err);
          if (typeof cb === 'function') cb('ATTEMPT_FAILED');
          return;
        }
        const serializable = rows.map((el) => el.serializable);
        if (typeof cb === 'function') {
          cb(null, serializable);
        } else {
          socket.emit('userStats', guildId, groupId, opt, serializable);
        }
      });
    });
  }
  this.fetchLeaderboard = fetchLeaderboard;
  /**
   * Handle receiving image data for avatar uploading.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {string} iId The image ID that is being uploaded.
   * @param {string} chunkId Id of the chunk being received.
   * @param {?Buffer} chunk Chunk of data received, or null if all data has been
   * sent.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function imageChunk(userData, socket, gId, iId, chunkId, chunk, cb) {
    const meta = imageBuffer[iId];
    if (!meta) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'imageChunk');
      return;
    }
    if (meta.uId != userData.id) {
      if (!checkMyGuild(gId)) return;
      if (typeof cb === 'function') cb('NO_PERM');
      replyNoPerm(socket, 'imageChunk');
      return;
    }
    if (meta.type == 'NPC') {
      if (!checkPerm(userData, gId, null, 'ai create')) {
        if (!checkMyGuild(gId)) return;
        if (typeof cb === 'function') cb('NO_PERM');
        replyNoPerm(socket, 'imageChunk');
        cancelImageUpload(iId);
        return;
      }
    } else {
      self.common.logWarning(
          'Unknown image type attempted to be uploaded: ' + meta.type,
          socket.id);
      cancelImageUpload(iId);
    }

    if (chunk) {
      chunk = Buffer.from(chunk);
      meta.receivedBytes += chunk.length;
      if (isNaN(chunkId * 1)) {
        cancelImageUpload(iId);
        if (typeof cb === 'function') cb('Malformed Data');
        return;
      } else if (meta.receivedBytes > hg().maxBytes) {
        cancelImageUpload(iId);
        if (typeof cb === 'function') cb('Data Overflow');
        return;
      }
      meta.buffer[chunkId] = chunk;
      if (typeof cb === 'function') cb(chunkId);
      return;
    }

    if (meta.type == 'NPC') {
      const npcId = hg().NPC.createID();
      const p = hg().NPC.saveAvatar(Buffer.concat(meta.buffer), npcId);
      if (!p) {
        cancelImageUpload(iId);
        if (typeof cb === 'function') cb('Malformed Data');
        return;
      }
      p.then((url) => {
        const error = hg().createNPC(gId, meta.username, url, npcId);
        const game = hg().getHG().getGame(gId);
        cancelImageUpload(iId);
        if (typeof cb === 'function') {
          cb(error, game && game.serializable);
        } else if (error) {
          socket.emit('message', error);
        }
        self.common.logDebug(
            'NPC Created from upload with URL: ' + url, socket.id);
      }).catch(() => {
        cancelImageUpload(iId);
        if (typeof cb === 'function') cb('Malformed Data');
      });
    } else {
      self.common.logWarning(
          'Unknown upload type completed. Data is being deleted. (' +
              meta.type + ')',
          socket.id);
      if (typeof cb === 'function') cb();
      cancelImageUpload(iId);
    }
  }
  this.imageChunk = imageChunk;
  /**
   * Handle client requesting to begin image upload.
   *
   * @private
   * @type {HGWeb~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The guild id to look at.
   * @param {object} meta Metadata to associate with this upload.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed. If succeeded, an upload ID will be passed as the
   * second parameter. Any error will be the first parameter.
   */
  function imageInfo(userData, socket, gId, meta, cb) {
    if (!meta || typeof meta.type !== 'string' ||
        isNaN(meta.contentLength * 1)) {
      if (typeof cb === 'function') cb('Malformed Data');
      return;
    }
    if (meta.type === 'NPC') {
      if (meta.contentLength > hg().maxBytes) {
        if (typeof cb === 'function') cb('Excessive Payload');
        return;
      }
      if (typeof meta.username !== 'string') {
        if (typeof cb === 'function') cb('Malformed Data');
        return;
      }
      meta.username = hg().formatUsername(meta.username);
      if (meta.username.length < 2) {
        if (typeof cb === 'function') cb('Malformed Data');
        return;
      }

      if (!checkPerm(userData, gId, null, 'ai create')) {
        if (!checkMyGuild(gId)) return;
        if (typeof cb === 'function') cb('NO_PERM');
        replyNoPerm(socket, 'imageInfo');
        return;
      }

      const buf = beginImageUpload(userData.id);
      buf.username = meta.username;
      buf.type = meta.type;
      if (typeof cb === 'function') cb(null, buf.id);
    } else {
      if (typeof cb === 'function') cb('NO_PERM');
    }
  }
  this.imageInfo = imageInfo;
}

module.exports = new HGWeb();
