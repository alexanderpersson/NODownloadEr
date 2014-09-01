/**
 * Created by Alexander Persson on 2014-08-22.
 */

var request     = require('request'),
    Notifier    = require('mail-notifier'),
    _           = require('lodash'),
    zlib        = require('zlib'),
    config      = require('./config'),
    email       = require('emailjs'),
    q           = require('q'),
    downloads   = []

var emailServer = email.server.connect({
    user: config.smtp.emailAddress,
    password: config.smtp.password,
    host: config.smtp.host,
    ssl: true
})

var mailNotifier = Notifier({
    user: config.imap.emailAddress,
    password: config.imap.password,
    host: config.imap.host,
    port: config.imap.port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
})

mailNotifier.on('mail', onMail)

function onMail(mail) {
    var from = mail.from[0].address
    if (_.contains(config.allowedDownloaders, from.toLowerCase())) {
        var mailData = {
            from: mail.from[0].address,
            subject: mail.subject
        }
        if (mail.subject.toLowerCase() == 'status') {
            returnStatus(mailData)
        }
        else {
            var trimmed = mail.text.trim()
            var rowIndex = trimmed.indexOf("\n")
            mailData.link = rowIndex === -1 ? trimmed : trimmed.substr(0, rowIndex)
            addTorrent(mailData)
        }
    }
    else {
        sendMail(from, 're: ' + mail.subject, 'Your email is not in the list of allowed downloaders.')
    }
}

function sendMail(recipient, subject, text) {
    emailServer.send({
        text: text,
        from: config.smtp.emailAddress,
        to: recipient,
        subject: subject
    })
}

function returnStatus(mailData) {
    getTorrents().then(function(data) {
        var text = createStatusResponse(data)
        sendMail(mailData.from, 're: ' + mailData.subject, text)
    }, asyncError)
}

function asyncError(error) {
    //TODO: do something meaningful
    console.log(error)
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
                    saveHash(diff, mailData)
                    sendMail(mailData.from, 're: ' + mailData.subject, 'Download started')
            }, asyncError)
        }, asyncError)
    }, asyncError)
}

function saveHash(hash, mailData) {
    downloads.push( {hash: hash, mailData: mailData })
}

function getDifference(before, after) {
    var beforeHashes = _.pluck(before, 'hash')
    var afterHashes = _.pluck(after, 'hash')
    var difference = _.difference(afterHashes, beforeHashes)
    if (difference.length > 0) {
        return difference[0]
    }
    else {
        return null
    }
}

function parseMagnet(url) {
    var deferred = q.defer()
    request(url, { encoding: null }, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            zlib.gunzip(body, function(error, dezipped) {
                if (!error) {
                    var data = dezipped.toString()
                    var magnet = parseMagnetFromHtml(data)
                    deferred.resolve(magnet)
                }
                else {
                    deferred.reject(error)
                }
            })
        }
        else {
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
    var deferred = q.defer()
    var url = createUtorentAddress("action=add-url&s=" + magnet)
    request(url, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            deferred.resolve(true)
        }
        else {
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
        if (torrent.percentage === 1000 && torrent.status !== 233) {
            var url = createUtorentAddress("action=pause&hash=" + torrent.hash)
            request(url, function(error, resposne, body) {
                var entry = _.first(downloads, { hash: torrent.hash })
                if (entry[0] != null) {
                    sendMail(entry[0].mailData.from, 're: ' + entry[0].mailData.subject, 'Download finished')
                    _.remove(downloads, function(item) { return item.hash === entry[0].hash })
                }
            })
        }
    })
}

setInterval(pauseTorrents, 10000)
mailNotifier.start()