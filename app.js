/**
 * Created by Alexander Persson on 2014-08-22.
 */

var request     = require('request'),
    Notifier    = require('mail-notifier'),
    _           = require('lodash'),
    zlib        = require('zlib'),
    config      = require('./config')