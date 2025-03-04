// Copyright 2018 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (dev@campbellcrowley.com)
const http = require('http');
const auth = require('../../auth.js');
require('../subModule.js').extend(WebCommands); // Extends the SubModule class.

const basicAuth = 'Basic ' +
    (auth.commandUsername + ':' + auth.commandPassword).toString('base64');

/**
 * @classdesc Handles receiving webhooks requests from external services.
 * @class
 * @augments SubModule
 */
function WebCommands() {
  const self = this;

  this.myName = 'Webhooks';

  let app;
  /** @inheritdoc */
  this.initialize = function() {
    app = http.createServer(handler);
    setTimeout(() => {
      app.listen(self.common.isRelease ? 8018 : 8019, '127.0.0.1');
    });
    app.on('error', function(err) {
      if (err.code === 'EADDRINUSE') {
        self.warn(
            'Webhooks failed to bind to port because it is in use. (' +
            err.port + ')');
        self.shutdown(true);
      } else {
        self.error('Webhooks failed to bind to port for unknown reason.', err);
      }
    });
  };
  /** @inheritdoc */
  this.shutdown = function() {
    if (app) app.close();
  };

  /**
   * Handler for all http requests.
   *
   * @private
   * @param {http.IncomingMessage} req The client's request.
   * @param {http.ServerResponse} res Our response to the client.
   */
  function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress ||
        'ERROR';
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      self.common.log(
          'Requested endpoint with invalid method: ' + req.method + ' ' +
              req.url,
          ip);
    } else if (req.url.indexOf('/webhook/botstart') > -1) {
      self.common.logDebug('Bot start webhook request: ' + req.url, ip);
      let content = '';
      req.on('data', (chunk) => {
        content += chunk;
      });
      req.on('end', () => {
        self.debug('Bot start webhook content: ' + content);
        res.writeHead(204);
        res.end();
      });
    } else if (req.url.indexOf('/webhook') < 0) {
      res.writeHead(501);
      res.end();
      self.common.log('Requested non-existent endpoint: ' + req.url, ip);
    } else if (req.headers.authorization !== basicAuth) {
      self.common.error(
          'Requested webhook with incorrect authorization header: ' +
              req.headers.authorization,
          ip);
      res.writeHead(401);
      res.end();
    } else {
      let content = '';
      req.on('data', (chunk) => {
        content += chunk;
      });
      req.on('end', () => {
        console.log(content);
        res.writeHead(204);
        res.end();
      });
    }
  }
}
module.exports = new WebCommands();
