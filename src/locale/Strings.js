// Copyright 2019 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (dev@campbellcrowley.com)
const fs = require('fs');
const Locale = require('./Locale.js');
/**
 * @description Static strings for Pets.
 */
class Strings {
  /**
   * @description Strings.
   * @param {string} [filename='global'] Filename to read strings from each
   * locale. Excluding path and extension.
   * @param {string} [dir='../..//strings/'] Path to find folder of available
   * locales, relative to this file.
   * @param {string} [defaultLocale='en_US'] Default and fallback locale to use
   * when unspecified or no string in given locale is found.
   */
  constructor(
      filename = 'global', dir = '../../strings/', defaultLocale = 'en_US') {
    if (typeof filename !== 'string') {
      throw new TypeError('Filename is not a string.');
    }
    if (typeof dir !== 'string') {
      throw new TypeError('Directory is not a string.');
    }
    defaultLocale = Strings.parseLocale(defaultLocale);
    if (!defaultLocale) {
      throw new TypeError('Default Locale is not a valid locale.');
    }
    /**
     * @description Path to directory storing locale information.
     * @private
     * @type {string}
     * @default '../../strings/'
     * @constant
     */
    this._stringsDir = dir;
    /**
     * @description Filename in locale directory to read strings from.
     * @private
     * @type {string}
     * @default '/global.js'
     * @constant
     */
    this._stringsFilename = `/${filename}.js`;
    /**
     * @description Default and fallback locale.
     * @private
     * @type {string}
     * @default 'en_US'
     * @constant
     */
    this._stringsDefault =
        `${defaultLocale.language}_${defaultLocale.territory}`;

    /**
     * @description Reference to default locale. This is used when a string key
     * is unable to be found in a locale, or the locale doesn't exist.
     * @public
     * @type {Strings~Locale}
     * @default
     */
    this.defaultLocale = require(
        `${this._stringsDir}${this._stringsDefault}${this._stringsFilename}`);

    this.get = this.get.bind(this);
  }

  /**
   * @description Regular Expression to match a valid locale. Attempts to
   * conform to ISO/IEC 15897. Does not accept modifier.
   */
  static get localRegExp() {
    return new RegExp(
        '^(?<language>[a-z]{2})(?:_(?<territory>[A-Z]{2}))?' +
        '(?:\\.(?<codeset>[^@]+))?$');
  }

  /**
   * @description Parse the given string as a locale.
   * @public
   * @static
   * @param {string} locale The locale to parse.
   * @returns {?{
   *   language: string,
   *   territory: ?string,
   *   codeset: ?string
   * }} Matched groups or null if not a valid locale.
   */
  static parseLocale(locale) {
    const match =
        typeof locale === 'string' && locale.match(Strings.localRegExp);
    return match && match.groups;
  }

  /**
   * @description Purge all strings from memory to force them to be reloaded.
   * Asynchronous. Does not complete immediately.
   * @public
   */
  purge() {
    fs.readdir(`${__dirname}/${this._stringsDir}`, (err, files) => {
      if (err) {
        console.error(err);
        return;
      }
      for (const f of files) {
        delete require.cache[require.resolve(
            `${this._stringsDir}${f}${this._stringsFilename}`)];
      }
    });
  }

  /**
   * @description Get and format a specific string.
   *
   * @public
   * @static
   * @param {string} key String key to find.
   * @param {string} [locale] Lookup the string in a specific locale.
   * @param {...string} [rep] Data to replace placeholders in the string.
   * @returns {?string} Matched and replaced string, or null if unable to find.
   */
  get(key, locale, ...rep) {
    const match = Strings.parseLocale(locale || this._stringsDefault);
    let localeGroup = this.defaultLocale;
    let lang = this._stringsDefault;
    if (!match) {
      console.error(`Unable to find locale: ${locale}`);
    } else {
      lang = `${match.language}_${match.territory}`;
    }
    try {
      localeGroup =
          require(`${this._stringsDir}${lang}${this._stringsFilename}`);
    } catch (err) {
      console.error(`Unable to find locale: ${lang}`);
    }
    return localeGroup.get(key, rep);
  }
}

Strings.Locale = Locale;

module.exports = Strings;
