const appmetrics        = require('appmetrics');
var stats             = require("stats-lite");
var log4js            = require('log4js');
var logger            = log4js.getLogger('metric_collector.js');
var config            = require('config');
var publisher         = require("./riemann_client");

var metricRegistry    = {};

var httpConfig = {
    "filters": [
        {
            "pattern" : "GET /v1/transaction/(.*)/(.*)/status",
            "to" : "transaction_status"
        },
        {
            "pattern" : "GET /v1/account/(.*)/(.*)/debit/suggest",
            "to" : "debit_suggest"
        },
        {
            "pattern" : "GET /v1/account/(.*)/(.*)/credit/suggest",
            "to" : "credit_suggest"
        },
        {
            "pattern" : "GET /v1/migrate/(.*)/(.*)/status",
            "to" : "migrate_status"
        },
        {
            "pattern" : "GET /v1/account/(.*)/(.*)/status",
            "to" : "account_status"
        },
        {
            "pattern" : "PUT /v1/credit/deferred/(.*)/(.*)/cancel",
            "to" : "deferred_cancel"
        },
        {
            "pattern" : "POST /v1/withdrawal/(.*)",
            "to" : "withdraw"
        },
        {
            "pattern" : "POST /callback/payment/(.*)/(.*)",
            "to" : "payment_callback"
        },
        {
            "pattern" : "GET /states/(.*)",
            "to" : "get_states"
        },
        {
            "pattern" : "GET /cities/(.*)/(.*)",
            "to" : "get_cities"
        },
        {
            "pattern" : "GET /branches/(.*)/(.*)/(.*)",
            "to" : "get_branches"
        },
        {
            "pattern" : "GET /v1/account/(.*)/(.*)/summary",
            "to" : "get_user_summary"
        }
    ]
};

function getQualifiedUrl(url){
    if (url.includes('/')){
        return url.replace(/^\/|\/$/g, '').replace(/\//g, '_')
    }

    return url;
}

// Initialize the app metrics monitor and bind events
function init(){
    publisher.init();

    appmetrics.setConfig("http", httpConfig);

    var monitoring = appmetrics.monitor();

    monitoring.on('cpu', function(cpu){
        addMetric("cpu", cpu);
    });

    monitoring.on('eventloop', function(eventloop){
        addMetric("eventloop", eventloop);
    });

    monitoring.on("http", function(http){
        addMetric("http", http);
    });

    publish();
}

function reset(){
    metricRegistry = {}
}

function emit(eventName, data){
    appmetrics.emit(eventName, data);
}

function append(eventName, value){
    if(!metricRegistry[eventName]){
        metricRegistry[eventName] = [value];
    }else{
        metricRegistry[eventName].push(value);
    }
}

function incrementCount(eventName){
    if(!metricRegistry[eventName]){
        metricRegistry[eventName] = 1;
    }else{
        metricRegistry[eventName] += 1;
    }
}

function appendStatus(eventName, status){
    var prefix = status <= 0 || status >= 500 ? "_5xx" : status >= 400 ? "_4xx" : status >= 300 ? "_3xx" : "_2xx";
    append(eventName + prefix, status);
}

function addMetric(eventName, data){
    try{
        switch (eventName){
            case "cpu" :
                append("cpu", data.process);
                break;
            case "eventloop":
                append("eventloop", data.latency.avg);
                break;
            case "http":
                var url = getQualifiedUrl(data.url);
                append(url+"_http_duration", data.duration);
                appendStatus(url+"_http_status", data.statusCode);
                incrementCount(url+"_http_tpt");
                break;
            default:
                break;
        }
    }catch(err){
        logger.error("Error pushing an event with event name and data {} and {}", eventName, data);
    }
}

function riemannPush(){
    var callback = function(err, data){
        if(err){
            logger.error("Error pushing to riemann, {}", err.code);
        }
    };

    var metrics = metricRegistry;
    reset();

    riemannPushAsync(metrics, callback);
}

function riemannPushAsync(metrics, callback){
    try{
        for(var metric in metrics){
            var summary = metrics[metric];
            var events = getEvents(metric, summary);
            for(var every in events){
                publisher.sendEvent(events[every]);
            }
        }
        callback(null, {});
    }catch(err){
        callback(err.code);
    }
}

function getEvents(eventName, data){
    var prefix = config.riemann.prefix;

    if(eventName.includes("http_status")){
        return [
            {
                "service" : prefix + "_" + eventName + "_count",
                "metric" : data.length,
                "tags" : [config.riemann.tag]
            }
        ]
    }

    if(eventName.includes("http_tpt")){
        return [
            {
                "service" : prefix + "_" + eventName,
                "metric" : data,
                "tags" : [config.riemann.tag]
            }
        ]
    }

    return [
        {
            "service" : prefix + "_" + eventName + "_median",
            "metric" : stats.median(data),
            "tags" : [config.riemann.tag]
        },
        {
            "service" : prefix + "_" + eventName + "_p95",
            "metric" : stats.percentile(data, "0.95"),
            "tags" : [config.riemann.tag]
        },
        {
            "service" : prefix + "_" + eventName + "_p99",
            "metric" : stats.percentile(data, "0.99"),
            "tags" : [config.riemann.tag]
        },
        {
            "service" : prefix + "_" + eventName + "_p995",
            "metric" : stats.percentile(data, "0.995"),
            "tags" : [config.riemann.tag]
        }
    ]

}

function publish(){
    setInterval(function () {riemannPush()}, config.riemann.pushInterval || 10000);
}

exports.emit = emit;
exports.init = init;