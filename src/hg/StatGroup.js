// Copyright 2018-2019 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (dev@campbellcrowley.com)
const Stats = require('./Stats.js');
const common = require('../common.js');
const crypto = require('crypto');
const fs = require('fs');
const rimraf = require('rimraf');

/**
 * @description Metadata to store along with a {@link HungryGames~StatGroup}
 * object. These values are user-defined and are not necessarily correct and are
 * not trustworthy for any processing.
 * @typedef {object} HGStatMetadata
 *
 * @property {string} [name] The user-defined name of this stats object.
 * @property {Date} [startTime] The timestamp at which this stats object starts
 * to include information.
 * @property {Date} [endTime] The timestamp of the last time this object
 * includes information for.
 * @property {Date} createDate The timestamp at which this stats object was
 * created.
 * @property {Date} modifiedDate The timestamp at which this stats object was
 * last modified.
 */

/**
 * @description HG stats for a single timeframe.
 * @memberof HungryGames
 * @inner
 */
class StatGroup {
  /**
   * @description Create group.
   * @param {GuildGame} parent The parent instance of this group.
   * @param {HGStatMetadata|string} [metadata] Additional information to store
   * with these stats, or ID if metadata should be read from file since this
   * group already exists.
   */
  constructor(parent, metadata) {
    let id;
    if (typeof metadata === 'string') {
      id = metadata;
      metadata = null;
    }

    // Ensure SQL connection is established.
    common.connectSQL();

    /**
     * @description The ID of this current bot.
     * @public
     * @type {string}
     * @constant
     */
    this.bot = parent.bot;

    /**
     * @description The guild ID where this stat group resides.
     * @public
     * @type {string}
     * @constant
     */
    this.guild = parent.id;

    /**
     * @description The unique ID for this stat group. Unique per-guild.
     * @public
     * @type {string}
     */
    this.id = id;
    if (!this.id) this.id = StatGroup.createID(parent);

    /**
     * @description Queue of callbacks to fire once an object has been read from
     * file. This is used to ensure that if multiple manipulations are requested
     * on a single object at the same time, all modifications will take place on
     * the same instance instead of overwriting eachother. Mapped by ID being
     * fetched.
     * @private
     * @type {object.<Array.<Function>>}
     * @default
     */
    this._fetchQueue = {};
    /**
     * @description Cache of Stats objects that are to be saved to file, and the
     * Timeout until it will be saved. Prevents saving the same file multiple
     * times at once.
     * @private
     * @type {object.<{data: HungryGames~Stats, timeout: Timeout}>}
     * @default
     */
    this._saveQueue = {};

    const dir = `${common.guildSaveDir}${parent.id}/hg/stats/`;
    /**
     * @description The directory where all of this group's information is
     * stored.
     * @private
     * @type {string}
     * @constant
     */
    this._dir = `${dir}${this.id}/`;

    this._fetchUser = this._fetchUser.bind(this);
    this.fetchUser = this.fetchUser.bind(this);
    this.setValue = this.setValue.bind(this);
    this.fetchValue = this.fetchValue.bind(this);
    this._saveUser = this._saveUser.bind(this);
    this.setMetaName = this.setMetaName.bind(this);
    this.setMetaStart = this.setMetaStart.bind(this);
    this.setMetaEnd = this.setMetaEnd.bind(this);
    this._fetchMetadata = this._fetchMetadata.bind(this);
    this._saveMetadata = this._saveMetadata.bind(this);
    this.reset = this.reset.bind(this);

    if (metadata) {
      this._saveMetadata(this._parseMetadata(metadata));
    } else {
      this._fetchMetadata((err, meta) => {
        if (err) {
          console.error(err);
          return;
        }
        this._saveMetadata(meta);
      });
    }
  }

  /**
   * @description Fetch stats for a specific user in this group. Returned stats
   * are modifiable, but changes will not persist unless saved to file.
   * @private
   * @param {string} uId The user ID of which to lookup.
   * @param {Function} cb Callback with optional error as first argument,
   * otherwise has stats as second argument.
   */
  _fetchUser(uId, cb) {
    if (typeof uId !== 'string' ||
        (uId !== 'meta' && !uId.match(/^(\d{17,19}|NPC[A-F0-9]+)$/))) {
      throw new TypeError('uId (' + uId + ') is not a valid ID.');
    }
    // Data is queued to be saved, and is still cached, return the cached
    // version instead of reading the stale version from file.
    if (this._saveQueue[uId]) {
      cb(null, this._saveQueue[uId].data);
      return;
    }
    if (!this._fetchQueue[uId]) {
      this._fetchQueue[uId] = [cb];
    } else {
      this._fetchQueue[uId].push(cb);
      return;
    }
    const self = this;
    const done = function(err, data) {
      self._fetchQueue[uId].forEach((el) => {
        try {
          el(err, data);
        } catch (err) {
          console.error(err);
        }
      });
      delete self._fetchQueue[uId];
    };
    if (uId === 'meta') {
      fs.readFile(`${this._dir}${uId}.json`, (err, data) => {
        if (err) {
          if (err.code === 'ENOENT') {
            data = '{}';
          } else {
            done(err);
            return;
          }
        }
        try {
          done(null, this._parseMetadata(JSON.parse(data)));
        } catch (err) {
          done(err);
        }
      });
    } else {
      const toSend = global.sqlCon.format(
          'SELECT * FROM HGStats WHERE ' +
              'botId=? AND guildId=? AND groupId=? AND userId=?',
          [this.bot, this.guild, this.id, uId]);
      global.sqlCon.query(toSend, (err, rows) => {
        if (err) {
          done(err);
          return;
        }
        if (!rows || rows.length == 0) {
          // Fallback to legacy filesytem.
          fs.readFile(`${this._dir}${uId}.json`, (err, data) => {
            if (err) {
              if (err.code === 'ENOENT') {
                data = '{}';
              } else {
                done(err);
                return;
              }
            }
            try {
              const parsed = JSON.parse(data);
              parsed.id = uId;
              done(null, Stats.from(parsed));
            } catch (err) {
              done(err);
            }
          });
        } else {
          const data = rows[0] || {};
          data.id = uId;
          done(null, Stats.from(data));
        }
      });
    }
  }

  /**
   * @description Fetch stats for a specific user in this group. Modified values
   * will not persist. Use functions to modify.
   * @todo Return immutable/frozen copy to enforce no-modify rule.
   * @public
   * @param {string} uId The user ID of which to lookup.
   * @param {Function} cb Callback with optional error as first argument,
   * otherwise has stats as second argument.
   */
  fetchUser(uId, cb) {
    this._fetchUser(uId, (err, stats) => {
      if (err) {
        cb(err);
        return;
      }
      // cb(null, common.deepFreeze(stats));
      cb(null, stats);
    });
  }

  /**
   * @description Options for fetching a group of user stats.
   * @typedef {object} HGStatGroupUserSelectOptions
   *
   * @property {string} [sort='wins'] Column to sort data by.
   * @property {boolean} [ascending=false] Sort ascending or descending order.
   * @property {number} [limit=10] Limit the number of fetched users.
   * @property {number} [offset=0] Offset start index of found users.
   */

  /**
   * @description Fetch stats for a group of users. If array of IDs is given,
   * data will not be sorted.
   * @public
   * @param {HGStatGroupUserSelectOptions|string[]} [opts] Options to specify
   * which users are fetched, or array of user IDs to fetch.
   * @param {Function} cb Callback with optional error as first argument,
   * otherwise has stats as second argument as array of
   * {@link HungryGames~Stats} objects.
   */
  fetchUsers(opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (typeof cb !== 'function') {
      throw new TypeError('Callback must be a function');
    }
    if (!opts || typeof opts !== 'object') {
      opts = {};
    }

    const onReply = function(err, rows) {
      if (err) {
        cb(err);
        return;
      }
      try {
        cb(null, rows.map((el) => {
          el.id = el.userId;
          return new Stats(el);
        }));
      } catch (err) {
        cb(err);
      }
    };

    if (Array.isArray(opts)) {
      if (opts.length === 0) {
        cb(null, []);
        return;
      }

      const userList = opts.map(() => `userId=?`).join(' OR ');

      const toSend = global.sqlCon.format(
          'SELECT * FROM HGStats WHERE ' +
              'botId=? AND guildId=? AND groupId=? AND (' + userList + ');',
          [this.bot, this.guild, this.id].concat(opts));
      global.sqlCon.query(toSend, onReply);
    } else {
      if (typeof opts.sort === 'undefined') {
        opts.sort = 'wins';
      } else if (typeof opts.sort !== 'string') {
        opts.sort = null;
      }
      if (typeof opts.limit === 'undefined') opts.limit = 10;
      if (!opts.offset || typeof opts.offset !== 'number' ||
          isNaN(opts.offset)) {
        opts.offset = 0;
      }

      const sort =
          (typeof opts.sort === 'string' ?
               ' ORDER BY ?? ' + (opts.ascending ? '' : 'DESC ') :
               '');

      const limit = typeof opts.limit === 'number' && !isNaN(opts.limit) ?
          `LIMIT ${opts.limit}` +
              (opts.offset ? ` OFFSET ${opts.offset}` : '') :
          '';

      const toSend = global.sqlCon.format(
          'SELECT * FROM HGStats WHERE ' +
              'botId=? AND guildId=? AND groupId=?' + sort + limit + ';',
          [this.bot, this.guild, this.id, opts.sort]);

      global.sqlCon.query(toSend, onReply);
    }
  }

  /**
   * @description Set a stat value for a single user.
   * @public
   * @param {string} uId The user ID of which to change.
   * @param {string} key The key of the value to change.
   * @param {*} value The value to store.
   * @param {Function} cb Callback with single optional error argument.
   */
  setValue(uId, key, value, cb) {
    this._fetchUser(uId, (err, data) => {
      if (err && err.code !== 'ENOENT') {
        cb(err);
        return;
      }
      data.set(key, value);
      this._saveUser(data);
      cb();
    });
  }

  /**
   * @description Fetch a stat value for a single user. Immutable.
   * @public
   * @param {string} uId The user ID of which to fetch.
   * @param {string} key The key of the value to fetch.
   * @param {Function} cb Callback with optional error argument, and matched
   * value.
   */
  fetchValue(uId, key, cb) {
    this._fetchUser(uId, (err, data) => {
      if (err) {
        cb(err);
        return;
      }
      cb(null, data.get(key));
    });
  }

  /**
   * @description Increment a value by an amount.
   * @public
   * @param {string} uId The user ID of which to modify.
   * @param {string} key The key of the value to modify.
   * @param {number} [amount=1] Amount to increment by. Can be negative to
   * decrement.
   * @param {Function} [cb] Callback with single optional error argument.
   */
  increment(uId, key, amount = 1, cb) {
    if (typeof amount !== 'number' || isNaN(amount)) {
      throw new TypeError('Amount is not a number.');
    }
    this._fetchUser(uId, (err, data) => {
      if (err) {
        if (typeof cb !== 'function') {
          console.error(err);
        } else {
          cb(err);
        }
        return;
      }
      if (!data.get(key)) data.set(key, 0);
      if (typeof data.get(key) !== 'number') {
        const err = new TypeError('Fetched value is not a number.');
        if (typeof cb !== 'function') {
          console.error(err);
        } else {
          cb(err);
        }
        return;
      }
      data.set(key, data.get(key) + amount);
      this._saveUser(data);
      if (typeof cb === 'function') cb();
    });
  }

  /**
   * @description Save a stats object to file.
   * @private
   * @param {HungryGames~Stats} data The stats object to save.
   * @param {boolean} [immediate=false] Force saving to happen immediately
   * instead of waiting until next event loop.
   */
  _saveUser(data, immediate = false) {
    if (this._saveQueue[data.id]) {
      clearTimeout(this._saveQueue[data.id].timeout);
      this._saveQueue[data.id].timeout = null;
    }
    if (!immediate) {
      this._saveQueue[data.id] = {
        data: data,
        timeout: setTimeout(
            () => this._saveUser(this._saveQueue[data.id].data, true), 1000),
      };
      return;
    }
    delete this._saveQueue[data.id];

    const setList = 'botId=?,guildId=?,groupId=?,userId=?,' +
        data.keys.map((el) => `${el}=?`).join(',');
    const valueList = [this.bot, this.guild, this.id, data.id].concat(
        Object.values(data.serializable));

    const toSend = global.sqlCon.format(
        'INSERT INTO HGStats SET ' + setList + ' ON DUPLICATE KEY UPDATE ' +
            setList + ';',
        valueList.concat(valueList));
    global.sqlCon.query(toSend, (err) => {
      if (err) {
        console.error(err);
        return;
      }
      const fn = `${this._dir}${data.id}.json`;
      if (fs.existsSync(fn)) {
        fs.unlink(fn, (err) => {
          if (err) {
            console.error('Failed to remove legacy user stat file:', fn);
            console.error(err);
          }
        });
      }
    });
    // common.mkAndWrite(
    //     `${this._dir}${data.id}.json`, this._dir, data.serializable);
  }

  /**
   * @description Set the metadata name.
   * @public
   * @param {string} name The new value.
   */
  setMetaName(name) {
    this.fetchMetadata((err, meta) => {
      if (err) {
        console.error(err);
        return;
      }
      meta.name = name;
      this._saveMetadata(meta);
    });
  }
  /**
   * @description Set the metadata start time.
   * @public
   * @param {Date|number|string} startTime Date parsable time.
   */
  setMetaStart(startTime) {
    this.fetchMetadata((err, meta) => {
      if (err) {
        console.error(err);
        return;
      }
      meta.startTime = new Date(startTime);
      this._saveMetadata(meta);
    });
  }

  /**
   * @description Set the metadata end time.
   * @public
   * @param {Date|number|string} endTime Date parsable time.
   */
  setMetaEnd(endTime) {
    this.fetchMetadata((err, meta) => {
      if (err) {
        console.error(err);
        return;
      }
      meta.endTime = new Date(endTime);
      this._saveMetadata(meta);
    });
  }

  /**
   * @description Fetch the metadata for this group from file.
   * @private
   * @param {Function} cb Callback with optional error argument, otherwise
   * second argument is parsed {@link HGStatMetadata}.
   */
  _fetchMetadata(cb) {
    this._fetchUser('meta', cb);
  }

  /**
   * @description Fetch the metadata for this group from file. Modified values
   * will not persist. Use functions to modify.
   * @private
   * @param {Function} cb Callback with optional error argument, otherwise
   * second argument is parsed {@link HGStatMetadata}.
   */
  fetchMetadata(cb) {
    this.fetchUser('meta', cb);
  }

  /**
   * @description Parse the given object into a {@link HGStatMetadata} object.
   * @private
   * @param {object} data The data to parse.
   * @returns {HGStatMetadata} The parsed object.
   */
  _parseMetadata(data) {
    const out = {};
    if (!data) data = {};
    if (data.name != null) out.name = data.name;
    if (data.startTime != null) out.startTime = new Date(data.startTime);
    if (data.endTime != null) out.endTime = new Date(data.endTime);
    out.createDate = data.createDate ? new Date(data.createDate) : new Date();
    out.modifiedDate =
        data.modifiedDate ? new Date(data.modifiedDate) : new Date();
    return out;
  }

  /**
   * @description Save the current metadata to file.
   * @private
   * @param {HGStatMetadata} meta The data to save. Overwrites existing data.
   * @param {boolean} [immediate=false] Force saving to perform immediately
   * instead of delaying until next event loop.
   */
  _saveMetadata(meta, immediate = false) {
    if (this._saveQueue.meta) {
      clearTimeout(this._saveQueue.meta.timeout);
      this._saveQueue.meta.timeout = null;
    }
    if (!immediate) {
      this._saveQueue.meta = {
        data: meta,
        timeout: setTimeout(
            () => this._saveMetadata(this._saveQueue.meta.data, true), 1000),
      };
      return;
    }
    const data = {
      name: meta.name,
      startTime: meta.startTime && meta.startTime.getTime(),
      endTime: meta.endTime && meta.endTime.getTime(),
      createDate: meta.createDate.getTime(),
      modifiedDate: Date.now(),
    };
    delete this._saveQueue.meta;
    common.mkAndWrite(`${this._dir}meta.json`, this._dir, data);
  }

  /**
   * @description Delete all data associated with this group.
   * @public
   */
  reset() {
    const self = this;
    const resetQueue = function() {
      const keys = Object.keys(self._saveQueue);
      for (const k of keys) {
        clearTimeout(self._saveQueue[k].timeout);
        delete self._saveQueue[k];
      }
    };
    resetQueue();
    const toSend = global.sqlCon.format(
        'DELETE FROM HGStats WHERE botId=? AND guildId=? AND groupID=?;',
        [this.bot, this.guild, this.id]);
    global.sqlCon.query(toSend, (err) => {
      if (err) console.error(err);
    });
    rimraf(this._dir, (err) => {
      if (err) console.error(err);
      resetQueue();
    });
  }

  /**
   * @description Check if a stat group with the given ID exists for the given
   * game.
   * @public
   * @static
   * @param {HungryGames~GuildGame} game The game of which the stats to look up.
   * @param {string} id The group ID to check for.
   * @returns {boolean} True if exists, false otherwise.
   */
  static exists(game, id) {
    const dir = `${common.guildSaveDir}${game.id}/hg/stats/`;
    return fs.existsSync(`${dir}${id}/`);
  }

  /**
   * @description Fetch list of IDs for all created groups.
   * @public
   * @static
   * @param {HungryGames~GuildGame} game The game to get list for.
   * @param {Function} cb Callback with optional error argument, otherwise
   * second argument is array of IDs as strings.
   */
  static fetchList(game, cb) {
    fs.readdir(`${common.guildSaveDir}${game.id}/hg/stats/`, cb);
  }

  /**
   * @description Create an ID for a new group.
   * @todo Limit number of IDs to prevent infinite loop finding new ID.
   * @public
   * @static
   * @param {HungryGames~GuildGame} game The game to create an ID for to ensure
   * no collisions.
   * @returns {string} Valid created ID.
   */
  static createID(game) {
    const dir = `${common.guildSaveDir}${game.id}/hg/stats/`;
    let output;
    do {
      const id = crypto.randomBytes(2).toString('hex').toUpperCase();
      output = `0000${id}`.slice(-4);
    } while (fs.existsSync(`${dir}${output}`));
    return output;
  }
}
module.exports = StatGroup;
