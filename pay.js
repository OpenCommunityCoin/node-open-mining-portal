var fs = require('fs');
var path = require('path');
var os = require('os');
var cluster = require('cluster');

var async = require('async');

var PoolLogger = require('./libs/logUtil.js');
var PaymentProcessor = require('./libs/paymentProcessor.js');

var algos = require('stratum-pool/lib/algoProperties.js');

JSON.minify = JSON.minify || require("node-json-minify");

if (!fs.existsSync('config.json')){
    console.log('config.json file does not exist. Read the installation/setup instructions.');
    return;
}

var portalConfig = JSON.parse(JSON.minify(fs.readFileSync("config.json", {encoding: 'utf8'})));
var poolConfigs;


var logger = new PoolLogger({
    logLevel: portalConfig.logLevel,
    logColors: portalConfig.logColors
});




try {
    require('newrelic');
    if (cluster.isMaster)
        logger.debug('NewRelic', 'Monitor', 'New Relic initiated');
} catch(e) {}


//Try to give process ability to handle 100k concurrent connections
try{
    var posix = require('posix');
    try {
        posix.setrlimit('nofile', { soft: 100000, hard: 100000 });
    }
    catch(e){
        if (cluster.isMaster)
            logger.warning('POSIX', 'Connection Limit', '(Safe to ignore) Must be ran as root to increase resource limits');
    }
    finally {
        // Find out which user used sudo through the environment variable
        var uid = parseInt(process.env.SUDO_UID);
        // Set our server's uid to that user
        if (uid) {
            process.setuid(uid);
            logger.debug('POSIX', 'Connection Limit', 'Raised to 100K concurrent connections, now running as non-root user: ' + process.getuid());
        }
    }
}
catch(e){
    if (cluster.isMaster)
        logger.debug('POSIX', 'Connection Limit', '(Safe to ignore) POSIX module not installed and resource (connection) limit was not raised');
}


if (cluster.isWorker){

    switch(process.env.workerType){
        case 'pool':
            new PoolWorker(logger);
            break;
        case 'paymentProcessor':
            new PaymentProcessor(logger);
            break;
        case 'website':
            new Website(logger);
            break;
        case 'profitSwitch':
            new ProfitSwitch(logger);
            break;
    }

    return;
} 


//Read all pool configs from pool_configs and join them with their coin profile
var buildPoolConfigs = function(){
    var configs = {};
    var configDir = 'payment_configs/';

    var poolConfigFiles = [];


    /* Get filenames of pool config json files that are enabled */
    fs.readdirSync(configDir).forEach(function(file){
        if (!fs.existsSync(configDir + file) || path.extname(configDir + file) !== '.json') return;
        var poolOptions = JSON.parse(JSON.minify(fs.readFileSync(configDir + file, {encoding: 'utf8'})));
        if (!poolOptions.enabled) return;
        poolOptions.fileName = file;
        poolConfigFiles.push(poolOptions);
    });


    /* Ensure no pool uses any of the same ports as another pool */
    for (var i = 0; i < poolConfigFiles.length; i++){
        var ports = Object.keys(poolConfigFiles[i].ports);
        for (var f = 0; f < poolConfigFiles.length; f++){
            if (f === i) continue;
            var portsF = Object.keys(poolConfigFiles[f].ports);
            for (var g = 0; g < portsF.length; g++){
                if (ports.indexOf(portsF[g]) !== -1){
                    logger.error('Master', poolConfigFiles[f].fileName, 'Has same configured port of ' + portsF[g] + ' as ' + poolConfigFiles[i].fileName);
                    process.exit(1);
                    return;
                }
            }

            if (poolConfigFiles[f].coin === poolConfigFiles[i].coin){
                logger.error('Master', poolConfigFiles[f].fileName, 'Pool has same configured coin file coins/' + poolConfigFiles[f].coin + ' as ' + poolConfigFiles[i].fileName + ' pool');
                process.exit(1);
                return;
            }

        }
    }


    poolConfigFiles.forEach(function(poolOptions){

        poolOptions.coinFileName = poolOptions.coin;

        var coinFilePath = 'coins/' + poolOptions.coinFileName;
        if (!fs.existsSync(coinFilePath)){
            logger.error('Master', poolOptions.coinFileName, 'could not find file: ' + coinFilePath);
            return;
        }

        var coinProfile = JSON.parse(JSON.minify(fs.readFileSync(coinFilePath, {encoding: 'utf8'})));
        poolOptions.coin = coinProfile;
        poolOptions.coin.name = poolOptions.coin.name.toLowerCase();

        if (poolOptions.coin.name in configs){

            logger.error('Master', poolOptions.fileName, 'coins/' + poolOptions.coinFileName
                + ' has same configured coin name ' + poolOptions.coin.name + ' as coins/'
                + configs[poolOptions.coin.name].coinFileName + ' used by pool config '
                + configs[poolOptions.coin.name].fileName);

            process.exit(1);
            return;
        }

        for (var option in portalConfig.defaultPoolConfigs){
            if (!(option in poolOptions)){
                var toCloneOption = portalConfig.defaultPoolConfigs[option];
                var clonedOption = {};
                if (toCloneOption.constructor === Object) {
                    Object.assign(clonedOption, toCloneOption);
                } else { 
                    clonedOption = toCloneOption;
                }
                poolOptions[option] = clonedOption;
            }
        }


        configs[poolOptions.coin.name] = poolOptions;

        if (!(coinProfile.algorithm in algos)){
            logger.error('Master', coinProfile.name, 'Cannot run a pool for unsupported algorithm "' + coinProfile.algorithm + '"');
            delete configs[poolOptions.coin.name];
        }

    });
    return configs;
};



var startPaymentProcessor = function(){

    var enabledForAny = false;
    for (var pool in poolConfigs){
        var p = poolConfigs[pool];
        var enabled = p.enabled && p.paymentProcessing && p.paymentProcessing.enabled;
        if (enabled){
            enabledForAny = true;
            break;
        }
    }

    console.log(poolConfigs);

    if (!enabledForAny)
        return;

    var worker = cluster.fork({
        workerType: 'paymentProcessor',
        pools: JSON.stringify(poolConfigs)
    });
    worker.on('exit', function(code, signal){
        logger.error('Master', 'Payment Processor', 'Payment processor died, spawning replacement...');
        setTimeout(function(){
            startPaymentProcessor(poolConfigs);
        }, 2000);
    });
};


(function init(){

    poolConfigs = buildPoolConfigs();

    startPaymentProcessor();

})();
