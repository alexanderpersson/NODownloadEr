/**
 * Created by Alexander Persson on 2014-08-22.
 */

var request     = require('request'),
    Notifier    = require('mail-notifier'),
    _           = require('lodash'),
    config      = require('./config'),
    email       = require('emailjs'),
    q           = require('q'),
    util        = require('util'),
    downloads   = [],
	mailNotifier = null

var emailServer = email.server.connect({
    user: config.smtp.emailAddress,
    password: config.smtp.password,
    host: config.smtp.host,
    ssl: true
})

function initializeNotifier() {
	mailNotifier = Notifier({
		user: config.imap.emailAddress,
		password: config.imap.password,
		host: config.imap.host,
		port: config.imap.port,
		tls: true,
		tlsOptions: { rejectUnauthorized: false }
	})	

	mailNotifier.on('mail', onMail)
	mailNotifier.on('end', function() {
		mailNotifier = null
		delete mailNotifier
		initializeNOtifier()
		mailNotifier.start()
		util.log('Restarted')
	})
}

function onMail(mail) {
    util.log('Got mail from ' + mail.from[0].address + ' with subject ' + mail.subject)
    var from = mail.from[0].address
    if (_.contains(config.allowedDownloaders, from.toLowerCase())) {
        util.log('Address is allowed')
        var mailData = {
            from: mail.from[0].address,
            subject: mail.subject
        }
        if (mail.subject.toLowerCase() == 'status') {
            util.log('Mail is only status message')
            returnStatus(mailData)
        }
        else {
            util.log('Parsing email for link')
            var trimmed = mail.text.trim()
            var rowIndex = trimmed.indexOf("\n")
            mailData.link = rowIndex === -1 ? trimmed : trimmed.substr(0, rowIndex)
            util.log('Got link ' + mailData.link)
            addTorrent(mailData)
        }
    }
    else {
        util.log('Address is not allowed')
        sendMail(from, 're: ' + mail.subject, 'Your email is not in the list of allowed downloaders.')
    }
}

function sendMail(recipient, subject, text) {
    util.log('Sending email')
    emailServer.send({
        text: text,
        from: config.smtp.emailAddress,
        to: recipient,
        subject: subject
    }, function(err, message) { util.log(err || 'Sent email'); })
}

function returnStatus(mailData) {
    util.log('Getting status')
    getTorrents().then(function(data) {
        var text = createStatusResponse(data)
        util.log('Got status ' + text)
        sendMail(mailData.from, 're: ' + mailData.subject, text)
    }, asyncError)
}

function asyncError(error) {
    //TODO: do something meaningful
    util.log(error)
}

function createStatusResponse(data) {
    var formatted = _.map(data, function(item) {
        return item.name + " " + item.percentage / 10 + "% "
    })
    var text = formatted.join('\n')
    return text
}

function createUtorentAddress(param) {
    return "http://" + config.utorrent.username + ":" + config.utorrent.password + "@localhost:" + config.utorrent.port + "/gui/?" + param
}

var listLink = createUtorentAddress("list=1")
function getTorrents() {
    var deferred = q.defer()
    request(listLink, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            var data = _.map(JSON.parse(body).torrents, function (torrent) {
                return { hash: torrent[0], status: torrent[1], name: torrent[2], percentage: torrent[4] }
            })
            deferred.resolve(data)
        }
        else {
            util.log(error)
            deferred.reject(error)
        }
    })

    return deferred.promise
}

function addTorrent(mailData) {
    parseMagnet(mailData.link).then(function (magnet) {
        getTorrents().then(function (before) {
            addTorrentToUtorrent(magnet).then(
                getTorrents, asyncError).then(function (after) {
                    var diff = getDifference(before, after)
                    util.log('Got new torrent ' + diff)
                    saveHash(diff, mailData)
                    sendMail(mailData.from, 're: ' + mailData.subject, 'Download started')
            }, asyncError)
        }, asyncError)
    }, asyncError)
}

function saveHash(hash, mailData) {
    util.log('Saves hash')
    downloads.push( {hash: hash, mailData: mailData })
}

function getDifference(before, after) {
    util.log('Looking for differences')
    var beforeHashes = _.pluck(before, 'hash')
    var afterHashes = _.pluck(after, 'hash')
    var difference = _.difference(afterHashes, beforeHashes)
    if (difference.length > 0) {
        util.log('Found a difference')
        return difference[0]
    }
    else {
        util.log('Found nothing')
        return null
    }
}

function parseMagnet(url) {
    util.log('Parsing html for magnet')
    var deferred = q.defer()
    request(url, { encoding: null }, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            var magnet = parseMagnetFromHtml(body.toString())
            util.log('Found magnet ' + magnet)
            deferred.resolve(magnet)
        }
        else {
            util.log(error)
            deferred.reject(error)
        }
    })
    return deferred.promise
}

function parseMagnetFromHtml(html) {
    var magnetStart = html.indexOf('href="magnet:?xt=') + 6
    var magnetEnd = html.indexOf('"', magnetStart) - magnetStart
    var magnet = html.substr(magnetStart, magnetEnd)
    return magnet
}

function addTorrentToUtorrent(magnet) {
    util.log('Adding torrent')
    var deferred = q.defer()
    var url = createUtorentAddress("action=add-url&s=" + magnet)
    request(url, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            util.log('Torrent added')
            deferred.resolve(true)
        }
        else {
            util.log(error)
            deferred.reject(error)
        }
    })
    return deferred.promise
}

function pauseTorrents() {
    getTorrents().then(doPauseTorrents, asyncError)
}

function doPauseTorrents(data) {
    _.each(data, function(torrent) {
        if (torrent.percentage === 1000 && !(torrent.status === 233 || torrent.status === 161 || torrent.status === 232)) {
            util.log('Pausing torrent ' + torrent.hash)
            var url = createUtorentAddress("action=pause&hash=" + torrent.hash)
            request(url, function(error, resposne, body) {
                var entry = _.first(downloads, { hash: torrent.hash })
                if (entry[0] != null) {
                    util.log('Paused torrent ' + entry[0].mailData.subject)
                    sendMail(entry[0].mailData.from, 're: ' + entry[0].mailData.subject, 'Download finished')
                    _.remove(downloads, function(item) { return item.hash === entry[0].hash })
                }
                else {
                    util.log('Paused torrent but none cared')
                }
            })
        }
    })
}

setInterval(pauseTorrents, 10000)
initializeNotifier()
mailNotifier.start()
util.log('Started')
