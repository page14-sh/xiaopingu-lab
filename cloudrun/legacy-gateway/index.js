require('node:http').createServer(require('./gateway').createGateway()).listen(Number(process.env.PORT||8787),'0.0.0.0');
