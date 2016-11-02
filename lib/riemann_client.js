/*global require: true, exports: true */

'use strict';

var log4js          = require('log4js');
var config          = require('config');
var log             = log4js.getLogger('riemann client');
var riemann         = require('riemann');

var settings = {
    initialReconnectTimeout : config.riemann.initialReconnectTimeout || 1000,
    reconnectLimit: config.riemann.reconnectLimit || 10000,
    keepAliveInternal: config.riemann.keepAliveInternal || 60000
};

var keepAlive, reconnectTimeout = settings.initialReconnectTimeout;
var riemannClient = {};
var isConnected = false;

function connect(){
    riemannClient = riemann.createClient({
        host: config.riemann.host,
        port: config.riemann.port
    });

    riemannClient.on('connect', function(){
        isConnected = true;
        reconnectTimeout = settings.initialReconnectTimeout;
        keepConnectionAlive();
    });

    riemannClient.on('disconnect', function(){
        isConnected = false;
        clearInterval(keepAlive);
    });

    riemannClient.on('error', function(err){
        isConnected = false;
        if(err.code === 'ECONNREFUSED'){
            //Try reconnecting using exponential backoff..
            reconnectTimeout = (reconnectTimeout * 2 < settings.reconnectLimit ? reconnectTimeout * 2 : settings.reconnectLimit);
            setTimeout(function () {
                riemannClient.disconnect();
                connect();
            }, reconnectTimeout);
        }else{
            log.error("Riemann seems to have gotten disconnected unexpectedly. Sorry can't help but try to reconnect!!");
            riemannClient.disconnect();
            connect();
        }
    });
}

function keepConnectionAlive(){
    keepAlive = setInterval(function () {
        sendEvent({description: 'keepAlive', tags: ['mercury', 'keepAlive']});
    }, settings.keepAliveInternal);
}

/**
 *
 * @param fields ({}) : fields or more colloquially event parameters expected by the node riemann client when creating an event
 * riemannClient.Event
 */
function sendEvent(eventParams){
    try{
        if(isConnected){
            var event = riemannClient.Event(eventParams);
            riemannClient.send(event, riemannClient.udp);
        }else{
            log.info("Cannot send event. Riemann is not connected");
        }
    }catch(err){
        log.error("Error trying to send an event to riemann with error: ", err.code);
    }
}

exports.sendEvent = sendEvent;

exports.init = function(){
    connect();
};


