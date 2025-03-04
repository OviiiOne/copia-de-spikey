// Copyright 2018-2019 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (web@campbellcrowley.com)
const http = require('http');
const auth = require('../../auth.js');
const socketIo = require('socket.io');

require('../subModule.js').extend(WebSettings);  // Extends the SubModule class.

/**
 * @classdesc Manages changing settings for the bot from a website.
 * @class
 * @augments SubModule
 */
function WebSettings() {
  const self = this;

  /** @inheritdoc */
  this.myName = 'WebSettings';

  /** @inheritdoc */
  this.initialize = function() {
    app.listen(self.common.isRelease ? 8020 : 8021, '127.0.0.1');
    setTimeout(updateModuleReferences, 100);

    self.command.addEventListener('settingsChanged', handleSettingsChanged);
    self.command.addEventListener('settingsReset', handleSettingsReset);
  };
  /** @inheritdoc */
  this.unloadable = function() {
    return getNumClients() == 0;
  };
  /** @inheritdoc */
  this.shutdown = function() {
    if (io) io.close();
    if (ioClient) {
      ioClient.close();
      ioClient = null;
    }
    if (app) app.close();
    if (cmdScheduler) {
      cmdScheduler.removeListener('shutdown', handleShutdown);
      cmdScheduler.removeListener('commandRegistered', handleCommandRegistered);
      cmdScheduler.removeListener('commandCancelled', handleCommandCancelled);
      self.command.removeEventListener(
          'settingsChanged', handleSettingsChanged);
      self.command.removeEventListener('settingsReset', handleSettingsReset);
    }
  };

  let ioClient;
  const app = http.createServer(handler);
  const io = socketIo(
      app, {path: '/www.spikeybot.com/socket.io/', serveClient: false});

  app.on('error', function(err) {
    if (io) io.close();
    if (app) app.close();
    if (err.code === 'EADDRINUSE') {
      self.warn(
          'Settings failed to bind to port because it is in use. (' + err.port +
          ')');
      startClient();
    } else {
      console.error('Settings failed to bind to port for unknown reason.', err);
    }
  });

  /**
   * Stores the current reference to the CmdScheduling subModule. Null if it
   * doesn't exist.
   *
   * @private
   * @type {?CmdScheduling}
   */
  let cmdScheduler;

  /**
   * Stores the current reference to the RaidBlock subModule. Null if it doesn't
   * exist.
   *
   * @private
   * @type {?RaidBlock}
   */
  let raidBlock;

  /**
   * Update the references to the aplicable subModules.
   *
   * @private
   */
  function updateModuleReferences() {
    if (!self.initialized) return;
    if (!cmdScheduler || !cmdScheduler.initialized) {
      cmdScheduler = self.bot.getSubmodule('./cmdScheduling.js');
      if (!cmdScheduler || !cmdScheduler.initialized) {
        cmdScheduler = null;
        setTimeout(updateModuleReferences, 100);
      } else {
        cmdScheduler.on('shutdown', handleShutdown);
        cmdScheduler.on('commandRegistered', handleCommandRegistered);
        cmdScheduler.on('commandCancelled', handleCommandCancelled);
      }
    }
    if (!raidBlock || !raidBlock.initialized) {
      raidBlock = self.bot.getSubmodule('./raidBlock.js');
      if (!raidBlock || !raidBlock.initialized) {
        raidBlock = null;
        if (cmdScheduler && cmdScheduler.initialized) {
          setTimeout(updateModuleReferences, 100);
        }
      } else {
        raidBlock.on('shutdown', handleRaidShutdown);
        raidBlock.on('lockdown', handleLockdown);
        raidBlock.on('action', handleRaidAction);
      }
    }
  }

  /**
   * Handle CmdScheduling shutting down.
   *
   * @private
   * @listens CmdScheduling#shutdown
   */
  function handleShutdown() {
    if (cmdScheduler) {
      cmdScheduler.removeListener('shutdown', handleShutdown);
      cmdScheduler.removeListener('commandRegistered', handleCommandRegistered);
      cmdScheduler.removeListener('commandCancelled', handleCommandCancelled);
    }
    cmdScheduler = null;
    if (!self.initialized) return;
    setTimeout(updateModuleReferences, 100);
  }
  /**
   * Handle RaidBlock shutting down.
   *
   * @private
   * @listens RaidBlock[w#shutdown
   */
  function handleRaidShutdown() {
    if (raidBlock) {
      raidBlock.removeListener('shutdown', handleRaidShutdown);
      raidBlock.removeListener('lockdown', handleLockdown);
      raidBlock.removeListener('action', handleRaidAction);
    }
    raidBlock = null;
    if (!self.initialized) return;
    setTimeout(updateModuleReferences, 100);
  }
  /**
   * Handle new CmdScheduling.ScheduledCommand being registered.
   *
   * @private
   * @listens CmdScheduling#commandRegistered
   *
   * @param {CmdScheduling.ScheduledCommand} cmd The command that was scheduled.
   * @param {string|number} gId The guild ID of which the command was scheduled
   * in.
   */
  function handleCommandRegistered(cmd, gId) {
    const toSend = {
      id: cmd.id,
      channel: cmd.channelId,
      cmd: cmd.cmd,
      repeatDelay: cmd.repeatDelay,
      time: cmd.time,
      member: makeMember(cmd.member),
    };
    for (const i in sockets) {
      if (sockets[i] && sockets[i].cachedGuilds &&
          sockets[i].cachedGuilds.includes(gId)) {
        sockets[i].emit('commandRegistered', toSend, gId);
      }
    }
    if (ioClient) {
      ioClient.emit('_guildBroadcast', gId, 'commandRegistered', toSend, gId);
    }
  }
  /**
   * Handle a CmdScheduling.ScheduledCommand being canceled.
   *
   * @private
   * @listens CmdScheduling#commandCancelled
   * @param {string} cmdId The ID of the command that was cancelled.
   * @param {string|number} gId The ID of the guild the command was cancelled
   * in.
   */
  function handleCommandCancelled(cmdId, gId) {
    for (const i in sockets) {
      if (sockets[i] && sockets[i].cachedGuilds &&
          sockets[i].cachedGuilds.includes(gId)) {
        sockets[i].emit('commandCancelled', cmdId, gId);
      }
    }
    if (ioClient) {
      ioClient.emit('_guildBroadcast', gId, 'commandCancelled', cmdId, gId);
    }
  }

  /**
   * Handle Command~CommandSetting value changed.
   *
   * @private
   * @listens Command.events#settingsChanged
   * @see {@link Command~CommandSetting.set}
   *
   * @param {?string} gId The ID of the guild this setting was changed in, or
   * null of not specific to a single guild.
   * @param {string} value Value of setting.
   * @param {string} type Type of value.
   * @param {string} id Setting id.
   * @param {string} [id2] Second setting id.
   */
  function handleSettingsChanged(gId, value, type, id, id2) {
    for (const i in sockets) {
      if (sockets[i] && sockets[i].cachedGuilds &&
          (!gId || sockets[i].cachedGuilds.includes(gId))) {
        sockets[i].emit('settingsChanged', gId, value, type, id, id2);
      }
    }
    if (ioClient) {
      ioClient.emit(
          '_guildBroadcast', gId, 'settingsChanged', gId, value, type, id, id2);
    }
  }

  /**
   * Handle Command~CommandSetting was deleted or reset in a guild.
   *
   * @private
   * @listens Command.events#settingsReset
   *
   * @param {string} gId The ID of the guild in which the settings were reset.
   */
  function handleSettingsReset(gId) {
    for (const i in sockets) {
      if (sockets[i] && sockets[i].cachedGuilds &&
          sockets[i].cachedGuilds.includes(gId)) {
        sockets[i].emit('settingsReset', gId);
      }
    }
    if (ioClient) {
      ioClient.emit('_guildBroadcast', gId, 'settingsReset', gId);
    }
  }

  /**
   * Handle a guild going on lockdown.
   *
   * @private
   * @listens RaidBlock#lockdown
   *
   * @param {{settings: RaidBlock~RaidSettings, id: string}} event Event
   * information.
   */
  function handleLockdown(event) {
    for (const i in sockets) {
      if (sockets[i] && sockets[i].cachedGuilds &&
          sockets[i].cachedGuilds.includes(event.id)) {
        sockets[i].emit('lockdown', event.id, event.settings);
      }
    }
    if (ioClient) {
      ioClient.emit(
          '_guildBroadcast', event.id, 'lockdown', event.id, event.settings);
    }
  }

  /**
   * Handle a guild lockdown action being performed.
   *
   * @private
   * @listens RaidBlock#action
   *
   * @param {{action: string, user: external:Discord~User}} event Event
   * information.
   */
  function handleRaidAction(event) {
    for (const i in sockets) {
      if (sockets[i] && sockets[i].cachedGuilds &&
          sockets[i].cachedGuilds.includes(event.id)) {
        sockets[i].emit('raidAction', event.id, event.action, event.user.id);
      }
    }
    if (ioClient) {
      ioClient.emit(
          '_guildBroadcast', event.id, 'raidAction', event.id, event.action,
          event.user.id);
    }
  }

  /**
   * Start a socketio client connection to the primary running server.
   *
   * @private
   */
  function startClient() {
    self.log(
        'Restarting into client mode due to server already bound to port.');
    ioClient = require('socket.io-client')(
        self.common.isRelease ? 'http://localhost:8020' :
                                'http://localhost:8021',
        {path: '/www.spikeybot.com/socket.io/control/'});
    clientSocketConnection(ioClient);
  }

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
   * @private
   * @returns {number} Number of sockets.
   */
  function getNumClients() {
    return Object.keys(sockets).length - Object.keys(siblingSockets).length;
  }

  /**
   * Map of all sockets connected that are siblings.
   *
   * @private
   * @type {object.<Socket>}
   */
  const siblingSockets = {};

  io.on('connection', socketConnection);
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
        'Socket connected Settings (' + Object.keys(sockets).length + '): ' +
            ipName,
        socket.id);
    sockets[socket.id] = socket;

    socket.emit('time', Date.now());

    // @TODO: Replace this authentication with gpg key-pairs;
    socket.on('vaderIAmYourSon', (verification, cb) => {
      if (verification === auth.webSettingsSiblingVerification) {
        siblingSockets[socket.id] = socket;
        cb(auth.webSettingsSiblingVerificationResponse);

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

    socket.on('fetchGuilds', (...args) => {
      callSocketFunction(fetchGuilds, args, false);
    });
    socket.on('fetchGuild', (...args) => {
      callSocketFunction(fetchGuild, args);
    });
    socket.on('fetchMember', (...args) => {
      callSocketFunction(fetchMember, args);
    });
    socket.on('fetchChannel', (...args) => {
      callSocketFunction(fetchChannel, args);
    });
    socket.on('fetchSettings', (...args) => {
      callSocketFunction(fetchSettings, args);
    });
    socket.on('fetchRaidSettings', (...args) => {
      callSocketFunction(fetchRaidSettings, args);
    });
    socket.on('fetchModLogSettings', (...args) => {
      callSocketFunction(fetchModLogSettings, args);
    });
    socket.on('fetchCommandSettings', (...args) => {
      callSocketFunction(fetchCommandSettings, args);
    });
    socket.on('fetchScheduledCommands', (...args) => {
      callSocketFunction(fetchScheduledCommands, args);
    });
    socket.on('fetchGuildScheduledCommands', (...args) => {
      callSocketFunction(fetchGuildScheduledCommands, args);
    });
    socket.on('cancelScheduledCommand', (...args) => {
      callSocketFunction(cancelScheduledCommand, args);
    });
    socket.on('registerScheduledCommand', (...args) => {
      callSocketFunction(registerScheduledCommand, args);
    });
    socket.on('changePrefix', (...args) => {
      callSocketFunction(changePrefix, args);
    });
    socket.on('changeRaidSetting', (...args) => {
      callSocketFunction(changeRaidSetting, args);
    });
    socket.on('changeModLogSetting', (...args) => {
      callSocketFunction(changeModLogSetting, args);
    });
    socket.on('changeCommandSetting', (...args) => {
      callSocketFunction(changeCommandSetting, args);
    });

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
    function callSocketFunction(func, args, forward = true) {
      const noLog = ['fetchMember', 'fetchChannel'];
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
          'Socket disconnected Settings (' + (Object.keys(sockets).length - 1) +
              '): ' + ipName,
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
      socket.emit(
          'vaderIAmYourSon', auth.webSettingsSiblingVerification, (res) => {
            self.common.log('Sibling authenticated successfully.');
            authenticated = res === auth.webSettingsSiblingVerificationResponse;
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
   * @returns {boolean} Whether the user has permission or not to manage the
   * hungry games in the given guild.
   */
  function checkPerm(userData, gId, cId, cmd) {
    if (!userData) return false;
    if (userData.id == self.common.spikeyId) return true;
    const msg = makeMessage(userData.id, gId, cId, cmd);
    if (!msg) return false;
    if (self.command.validate(null, makeMessage(userData.id, gId, null, cmd))) {
      return false;
    }
    return true;
  }
  /**
   * Check that the given user has permission to see and send messages in the
   * given channel, as well as manage the games in the given guild.
   *
   * @private
   * @param {UserData} userData The user to check.
   * @param {string} gId The guild id of the guild that contains the channel.
   * @param {string} cId The channel id to check against.
   * @returns {boolean} Whether the user has permission or not to manage the
   * hungry games in the given guild and has permission to send messages in the
   * given channel.
   */
  function checkChannelPerm(userData, gId, cId) {
    if (!userData) return false;
    const g = self.client.guilds.get(gId);
    if (!g) return false;
    if (userData.id == self.common.spikeyId) return true;
    const m = g.members.get(userData.id);
    if (!m) return false;

    const channel = g.channels.get(cId);
    if (!channel) return false;

    const perms = channel.permissionsFor(m);
    if (!perms.has(self.Discord.Permissions.FLAGS.VIEW_CHANNEL)) return false;
    if (!perms.has(self.Discord.Permissions.FLAGS.SEND_MESSAGES)) return false;
    return true;
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
    if (!m) return null;
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
      user: {
        username: m.user.username,
        tag: m.user.tag,
        discriminator: m.user.discriminator,
        avatarURL: m.user.displayAvatarURL(),
        id: m.user.id,
        bot: m.user.bot,
      },
      joinedTimestamp: m.joinedTimestamp,
    };
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
   * Basic callback with single argument. The argument is null if there is no
   * error, or a string if there was an error.
   *
   * @callback WebSettings~basicCB
   *
   * @param {?string} err The error response.
   */

  /**
   * Fetch all relevant data for all mutual guilds with the user and send it to
   * the user.
   *
   * @private
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function fetchGuilds(userData, socket, cb) {
    if (!userData) {
      self.common.error('Fetch Guilds without userData', 'WebSettings');
      if (typeof cb === 'function') cb('Not signed in', null);
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
    Object.values(siblingSockets).forEach((obj) => {
      obj.emit('fetchGuilds', userData, socket.id, done);
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
      socket.cachedGuilds = strippedGuilds.map((g) => g.id);
      done(strippedGuilds);
    } catch (err) {
      self.error(err);
      // socket.emit('guilds', 'Failed', null);
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
      const member = g.members.get(userData.id);
      const newG = {};
      newG.iconURL = g.iconURL();
      newG.name = g.name;
      newG.id = g.id;
      newG.ownerId = g.ownerID;
      newG.members = g.members.map((m) => {
        return m.id;
      });
      newG.channels =
          g.channels
              .filter((c) => {
                const perms = c.permissionsFor(member);
                return userData.id == self.common.spikeyId ||
                    (perms &&
                     perms.has(self.Discord.Permissions.FLAGS.VIEW_CHANNEL));
              })
              .map((c) => {
                return c.id;
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
      // cb(null);
      return;
    }
    if (userData.id != self.common.spikeyId &&
        !guild.members.get(userData.id)) {
      // cb(null);
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
    if (typeof cb !== 'function') return;
    if (!checkPerm(userData, gId, null, 'players')) return;
    const g = self.client.guilds.get(gId);
    if (!g) return;
    const m = g.members.get(mId);
    if (!m) {
      cb('No Member');
      return;
    }
    const finalMember = makeMember(m);

    cb(null, finalMember);
  }
  this.fetchMember = fetchMember;

  /**
   * Client has requested data for a specific channel.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {number|string} gId The ID of the Discord guild where the channel
   * is.
   * @param {number|string} cId The ID of the Discord channel to fetch.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete and has data, or has failed.
   */
  function fetchChannel(userData, socket, gId, cId, cb) {
    if (!checkMyGuild(gId)) return;
    if (typeof cb !== 'function') cb = function() {};
    if (!checkChannelPerm(userData, gId, cId)) {
      replyNoPerm(socket, 'fetchChannel');
      cb(null);
      return;
    }
    const c = self.client.channels.get(cId);
    const m = self.client.guilds.get(gId).members.get(userData.id);
    const perms = c.permissionsFor(m);
    const stripped = {
      id: c.id,
      permissions: perms,
      name: c.name,
      position: c.position,
      type: c.type,
    };
    if (c.parent) {
      stripped.parent = {position: c.parent.position};
    }
    cb(stripped);
  }
  this.fetchChannel = fetchChannel;

  /**
   * Client has requested all settings for all guilds for the connected user.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete and has data, or has failed.
   */
  function fetchSettings(userData, socket, cb) {
    if (!userData) {
      if (typeof cb === 'function') cb('Not signed in.', null);
      return;
    }
    let guilds = [];
    if (userData.guilds && userData.guilds.length > 0) {
      userData.guilds.forEach((el) => {
        const g = self.client.guilds.get(el.id);
        if (!g) return;
        guilds.push(g);
      });
    } else {
      guilds = self.client.guilds.filter((obj) => {
        return userData.id == self.common.spikeyId ||
            obj.members.get(userData.id);
      });
    }
    const cmdDefaults = self.command.getDefaultSettings();
    const modLog = self.bot.getSubmodule('./modLog.js');
    const settings = guilds.map((g) => {
      return {
        guild: g.id,
        prefix: self.bot.getPrefix(g),
        commandSettings: self.command.getUserSettings(g.id),
        commandDefaults: cmdDefaults,
        raidSettings: raidBlock && raidBlock.getSettings(g.id) || null,
        modLogSettings: modLog && modLog.getSettings(g.id) || null,
      };
    });
    if (!socket.fake && typeof cb === 'function') {
      cb(settings);
    } else {
      socket.emit('settings', settings);
    }
  }
  this.fetchSettings = fetchSettings;

  /**
   * Client has requested settings specific to raids for single guild.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string} gId The guild ID to fetch the settings for.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete and has data, or has failed.
   */
  function fetchRaidSettings(userData, socket, gId, cb) {
    if (!checkMyGuild(gId)) return;
    if (typeof cb !== 'function') cb = function() {};
    if (!userData) {
      cb('Not signed in.', null);
      return;
    }
    if (userData.id != self.common.spikeyId) {
      const guild = self.client.guilds.get(gId);
      const member = guild.members.get(userData.id);
      if (!member) {
        cb('NO_PERM');
        return;
      }
    }
    if (!raidBlock) {
      cb('Internal Server Error');
      return;
    }
    cb(raidBlock.getSettings(gId));
  }
  this.fetchRaidSettings = fetchRaidSettings;

  /**
   * Client has requested settings specific to ModLog for single guild.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string} gId The guild ID to fetch the settings for.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete and has data, or has failed.
   */
  function fetchModLogSettings(userData, socket, gId, cb) {
    if (!checkMyGuild(gId)) return;
    if (typeof cb !== 'function') cb = function() {};
    if (!userData) {
      cb('Not signed in.', null);
      return;
    }
    if (userData.id != self.common.spikeyId) {
      const guild = self.client.guilds.get(gId);
      const member = guild.members.get(userData.id);
      if (!member) {
        cb('NO_PERM');
        return;
      }
    }
    const modLog = self.bot.getSubmodule('./modLog.js');
    if (!modLog) {
      cb('Internal Server Error');
      return;
    }
    cb(modLog.getSettings(gId));
  }
  this.fetchModLogSettings = fetchModLogSettings;

  /**
   * Client has requested settings specific to a single command in a single
   * guild. This only supplies user settings, if values are default, this will
   * reply with null.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string} gId The guild ID to fetch the settings for.
   * @param {?string} cmd The name of the command to fetch the setting for, or
   * null to fetch all settings.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete and has data, or has failed.
   */
  function fetchCommandSettings(userData, socket, gId, cmd, cb) {
    if (!checkMyGuild(gId)) return;
    if (typeof cb !== 'function') cb = function() {};
    if (!userData) {
      cb('Not signed in.', null);
      return;
    }
    if (userData.id != self.common.spikeyId) {
      const guild = self.client.guilds.get(gId);
      const member = guild.members.get(userData.id);
      if (!member) {
        cb('NO_PERM');
        return;
      }
    }
    let settings = self.command.getUserSettings(gId);
    if (cmd) {
      const command = self.command.find(cmd);
      if (!command) {
        settings = null;
      } else {
        settings = settings[command.getFullName()];
      }
    }
    cb(settings);
  }
  this.fetchCommandSettings = fetchCommandSettings;

  /**
   * Client has requested all scheduled commands for the connected user.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete and has data, or has failed.
   */
  function fetchScheduledCommands(userData, socket, cb) {
    if (!userData) {
      if (!socket.fake && typeof cb === 'function') cb('Not signed in.', null);
      return;
    }
    let guilds = userData.guilds;
    if (guilds) {
      guilds.map((el) => self.client.guilds.get(el.id));
    } else {
      guilds = self.client.guilds.filter((obj) => {
        return obj.members.get(userData.id);
      });
    }
    const sCmds = {};
    updateModuleReferences();
    if (!cmdScheduler) {
      self.warn('Failed to get reference to CmdScheduler!');
      return;
    }
    guilds.forEach((g) => {
      if (!g) return;
      const list = cmdScheduler.getScheduledCommandsInGuild(g.id);
      if (list && list.length > 0) {
        sCmds[g.id] = list.map((el) => {
          return {
            id: el.id,
            channel: el.channel.id,
            cmd: el.cmd,
            repeatDelay: el.repeatDelay,
            time: el.time,
            member: makeMember(el.member),
          };
        });
      }
    });
    if (!socket.fake && typeof cb === 'function') {
      cb(sCmds);
    } else {
      socket.emit('scheduledCmds', sCmds);
    }
  }
  this.fetchScheduledCommands = fetchScheduledCommands;

  /**
   * Client has requested scheduled commands for a guild.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string} gId The guild ID to fetch.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete and has data, or has failed.
   */
  function fetchGuildScheduledCommands(userData, socket, gId, cb) {
    if (!checkMyGuild(gId)) return;
    if (typeof cb !== 'function') cb = function() {};
    if (!userData) {
      cb('Not signed in.', null);
      return;
    }
    if (userData.id != self.common.spikeyId) {
      const guild = self.client.guilds.get(gId);
      const member = guild.members.get(userData.id);
      if (!member) {
        cb('NO_PERM');
        return;
      }
    }
    updateModuleReferences();
    if (!cmdScheduler) {
      self.warn('Failed to get reference to CmdScheduler!');
      return;
    }
    const list = cmdScheduler.getScheduledCommandsInGuild(gId);
    let sCmds;
    if (list && list.length > 0) {
      sCmds = list.map((el) => {
        return {
          id: el.id,
          channel: el.channel.id,
          cmd: el.cmd,
          repeatDelay: el.repeatDelay,
          time: el.time,
          member: makeMember(el.member),
        };
      });
    }
    cb(sCmds);
  }
  this.fetchGuildScheduledCommands = fetchGuildScheduledCommands;
  /**
   * Client has requested that a scheduled command be cancelled.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string|number} gId The id of the guild of which to cancel the
   * command.
   * @param {string} cmdId The ID of the command to cancel.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function cancelScheduledCommand(userData, socket, gId, cmdId, cb) {
    if (typeof cb !== 'function') cb = function() {};
    if (!checkPerm(userData, gId, null, 'schedule')) {
      if (!checkMyGuild(gId)) return;
      replyNoPerm(socket, 'cancelScheduledCommand');
      cb('Forbidden');
      return;
    }
    updateModuleReferences();
    cmdScheduler.cancelCmd(gId, cmdId);
    cb();
  }
  this.cancelScheduledCommand = cancelScheduledCommand;

  /**
   * @description Client has created a new scheduled command.
   * @see {@link CmdScheduling~ScheduledCommand}
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string|number} gId The id of the guild of which to add the command.
   * @param {object} cmd The command data of which to make into a
   * scheduled command and register.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function registerScheduledCommand(userData, socket, gId, cmd, cb) {
    if (typeof cb !== 'function') cb = function() {};
    if (!checkMyGuild(gId)) return;
    if (!checkPerm(userData, gId, cmd && cmd.channel, 'schedule')) {
      replyNoPerm(socket, 'registerScheduledCommand');
      cb('Forbidden');
      return;
    }
    if (!cmd || typeof cmd !== 'object') {
      cb('Invalid Data');
      return;
    }
    if (!cmd.time || cmd.time < Date.now()) {
      cb('Time cannot be in past.');
      return;
    }
    updateModuleReferences();
    if (cmd.repeatDelay && cmd.repeatDelay < cmdScheduler.minRepeatDelay) {
      cb('Repeat time is too soon.');
      return;
    }
    let cId = self.client.channels.get(cmd.channel);
    if (!cId) {
      cb('Invalid Channel');
      return;
    }
    cId = cId.id;
    if (typeof cmd.cmd !== 'string') {
      cb('Invalid Command');
      return;
    }

    const msg = makeMessage(userData.id, gId, cId, cmd.cmd);

    if (!msg) {
      cb('Invalid Member');
      return;
    }

    const invalid = self.command.validate(cmd.cmd.split(/\s/)[0], msg);
    if (invalid) {
      cb('Invalid Command');
      return;
    }

    const prefix = self.bot.getPrefix(gId);
    if (!cmd.cmd.startsWith(prefix)) {
      cmd.cmd = prefix + cmd.cmd;
    }

    const single = self.command.find(cmd.cmd, {prefix: prefix});
    if (!single) {
      cb('Invalid Command');
      return;
    }
    if (single.getFullName() === self.command.find('sch').getFullName()) {
      cb('Invalid Command');
      return;
    }

    const newCmd = new cmdScheduler.ScheduledCommand({
      cmd: cmd.cmd,
      channel: msg.channel,
      message: msg,
      time: cmd.time,
      repeatDelay: cmd.repeatDelay,
      member: msg.member,
    });

    if (!cmdScheduler.registerScheduledCommand(newCmd)) {
      cb('Time is too close to existing command.');
    } else {
      cb(null);
    }
  }
  this.registerScheduledCommand = registerScheduledCommand;

  /**
   * Client has requested to change the command prefix for a guild.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string|number} gId The id of the guild of which to change the
   * prefix.
   * @param {string} prefix The new prefix value to set.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function changePrefix(userData, socket, gId, prefix, cb) {
    if (typeof cb !== 'function') cb = function() {};
    if (!checkPerm(userData, gId, null, 'changeprefix')) {
      if (!checkMyGuild(gId)) return;
      replyNoPerm(socket, 'changePrefix');
      cb('Forbidden');
      return;
    }
    try {
      self.bot.changePrefix(gId, prefix);
    } catch (err) {
      cb('Internal Error');
      return;
    }
    cb();
  }
  this.changePrefix = changePrefix;

  /**
   * Client has requested to change a single raid setting for a guild.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string|number} gId The id of the guild of which to change the
   * setting.
   * @param {string} key The name of the setting to change.
   * @param {string|boolean} value The value to set the setting to.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function changeRaidSetting(userData, socket, gId, key, value, cb) {
    if (typeof cb !== 'function') cb = function() {};
    if (!checkPerm(userData, gId, null, 'lockdown')) {
      if (!checkMyGuild(gId)) return;
      replyNoPerm(socket, 'changeRaidSetting');
      cb('Forbidden');
      return;
    }
    if (!raidBlock) {
      cb('Internal Server Error');
      self.common.error(
          'Attempted to change RaidBlock settings while raidBlock.js ' +
              'is not loaded!',
          socket.id);
      return;
    }
    const settings = raidBlock.getSettings(gId);
    if (typeof settings[key] === 'number') {
      value *= 1;
      if (isNaN(value)) {
        cb('Bad Payload');
        return;
      }
    }


    if (typeof settings[key] === typeof value) {
      if (typeof value === 'string' && value.length > 1000) {
        value = value.substr(0, 1000);
      }
      settings[key] = value;
    } else {
      cb('Bad Payload');
      return;
    }
    cb();

    for (const i in sockets) {
      if (sockets[i] && sockets[i].cachedGuilds &&
          sockets[i].cachedGuilds.includes(gId)) {
        sockets[i].emit('raidSettingsChanged', gId);
      }
    }
    if (ioClient) {
      ioClient.emit('_guildBroadcast', gId, 'raidSettingsChanged', gId);
    }
  }
  this.changeRaidSetting = changeRaidSetting;

  /**
   * Client has requested to change a single ModLog setting for a guild.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string|number} gId The id of the guild of which to change the
   * setting.
   * @param {string} key The name of the setting to change.
   * @param {string|boolean} value The value to set the setting to.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function changeModLogSetting(userData, socket, gId, key, value, cb) {
    if (!checkMyGuild(gId)) return;
    if (typeof cb !== 'function') cb = function() {};
    if (!checkPerm(userData, gId, null, 'setlogchannel')) {
      replyNoPerm(socket, 'changeModLogSetting');
      cb('Forbidden');
      return;
    }
    const modLog = self.bot.getSubmodule('./modLog.js');
    if (!modLog) {
      cb('Internal Server Error');
      self.common.error(
          'Attempted to change ModLog settings while modLog.js is not loaded!',
          socket.id);
      return;
    }
    const settings = modLog.getSettings(gId);
    if (typeof settings[key] === 'number') {
      value *= 1;
      if (isNaN(value)) {
        cb('Bad Payload');
        return;
      }
    }
    if (key === 'channel') {
      const channel = self.client.guilds.get(gId).channels.get(value);
      if (!channel) {
        cb('Bad Payload');
        return;
      } else {
        settings[key] = value;
      }
    } else if (typeof settings[key] === typeof value) {
      settings[key] = value;
    } else {
      cb('Bad Payload');
      return;
    }
    cb();

    for (const i in sockets) {
      if (sockets[i] && sockets[i].cachedGuilds &&
          sockets[i].cachedGuilds.includes(gId)) {
        sockets[i].emit('modLogSettingsChanged', gId);
      }
    }
    if (ioClient) {
      ioClient.emit('_guildBroadcast', gId, 'modLogSettingsChanged', gId);
    }
  }
  this.changeModLogSetting = changeModLogSetting;

  /**
   * Client has requested to change a single command setting for a guild.
   *
   * @public
   * @type {WebSettings~SocketFunction}
   * @param {object} userData The current user's session data.
   * @param {socketIo~Socket} socket The socket connection to reply on.
   * @param {string|number} gId The id of the guild of which to change the
   * setting.
   * @param {string} cmd The name of the command to change the setting for.
   * @param {string} key The name of the setting to change.
   * @param {string|boolean} value The value to set the setting to, or the key
   * if changing an enabled or disabled category.
   * @param {?string} id The ID of the channel, user, or role to change
   * the setting for if changing the enabled or disabled category.
   * @param {?boolean} enabled The setting to set the value of the ID setting.
   * @param {basicCB} [cb] Callback that fires once the requested action is
   * complete, or has failed.
   */
  function changeCommandSetting(
      userData, socket, gId, cmd, key, value, id, enabled, cb) {
    if (!checkMyGuild(gId)) return;
    if (typeof cb !== 'function') cb = function() {};
    if (!checkPerm(userData, gId, null, 'enable') ||
        !checkPerm(userData, gId, null, 'disable')) {
      replyNoPerm(socket, 'changeCommandSetting');
      cb('Forbidden');
      return;
    }
    const command = self.command.find(cmd);
    if (!command) {
      cb('Bad Payload');
      return;
    }
    const userSettings = self.command.getUserSettings(gId);
    const name = command.getFullName();
    if (!userSettings[name]) {
      userSettings[name] = new self.command.CommandSetting(command.options);
    }

    const setting = userSettings[name];

    if (typeof setting[key] === 'object' && typeof value === 'string') {
      if (typeof id !== 'string' ||
          typeof setting[key][value] === 'undefined') {
        cb('Bad Payload');
        return;
      } else {
        if (enabled === true) {
          setting[key][value][id] = true;
        } else if (enabled === false) {
          delete setting[key][value][id];
        } else {
          cb('Bad Payload');
          return;
        }
      }
    } else if (typeof setting[key] !== typeof value) {
      cb('Bad Payload');
      return;
    } else {
      setting[key] = value;
    }

    cb();

    for (const i in sockets) {
      if (sockets[i] && sockets[i].cachedGuilds &&
          sockets[i].cachedGuilds.includes(gId)) {
        sockets[i].emit('commandSettingsChanged', gId, name );
      }
    }
    if (ioClient) {
      ioClient.emit('_guildBroadcast', gId, 'commandSettingsChanged', gId);
    }
  }
  this.changeCommandSetting = changeCommandSetting;
}
module.exports = new WebSettings();
