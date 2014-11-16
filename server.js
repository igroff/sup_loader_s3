var aws             = require('aws-sdk');
var express         = require('express');
var morgan          = require('morgan');
var connect         = require('connect');
var log             = require('simplog');
var busboy          = require('connect-busboy');
var path            = require('path');
/* jshint -W079 */
var Promise         = require('bluebird');
/* jshint +W079 */
var fs              = Promise.promisifyAll(require('fs'));
var mime            = require('mime');
var mkdirp          = require('mkdirp');

config = {
  storageRoot: process.env.STORAGE_ROOT || path.join(__dirname, 'files')
};

var app = express();

app.use(connect());
app.use(morgan('combined'));
app.use(busboy());

function getPaths(fileName) {
  var filePath = path.join(config.storageRoot, fileName);
  var baseName = path.basename(filePath);
  var metaDataFilePath = path.join(config.storageRoot, "." + baseName + ".md");
  return {file: filePath, metadata: metaDataFilePath};
}

function getWriteStream(fileName){
  return fs.createWriteStream(fileName);
}
function getReadStream(fileName){
  return fs.createReadStream(fileName);
}

// respond
app.post('*', function(req, res){
  if (req.is('multipart/form-data')){
    req.busboy.on('finish', function(){ res.end(); });
    // write files
    req.busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
      var paths = getPaths(filename);
      file.pipe(getWriteStream(paths.file));
    });
    req.pipe(req.busboy);
  } else {
    function storeRequest(paths){
      var metaDataFileStream = getWriteStream(paths.metadata);
      var metaDataFileSaved = new Promise(function(resolve, reject){
        metaDataFileStream.on('close', resolve);
        metaDataFileStream.on('error', reject);
      });
      metaDataFileStream.write(
        JSON.stringify({mimetype:req.get('Content-Type')}),
        function() { metaDataFileStream.close(); }
      );

      dataFileStream = getWriteStream(paths.file);
      dataFileSaved = new Promise(function(resolve, reject){
        dataFileStream.on('close', resolve);
        dataFileStream.on('error', reject);
      }); 
      req.pipe(dataFileStream);
      return Promise.all([metaDataFileSaved, dataFileSaved]);
    }

    // promisify hates mkdirp, so... manual
    function makeDirectories(paths){
      return new Promise(function(resolve, reject){
        // files go into the same path structure so one is just as good
        // as the other (i.e. paths.file or paths.metadata)
        mkdirp(path.dirname(paths.file), function(e){
          if (e){
            reject(e);
          } else {
            resolve(paths);
          }
        })
      });
    };

    Promise
    .resolve(getPaths(req.path))
    .then(makeDirectories)
    .then(storeRequest)
    .then(function(){ res.end(undefined); })
    .catch(function(e){
        log.error("error writing file: ", e);
        res.status(500).send(e);
      }
    );
  }
});

app.get('*', function(req, res){
  var paths = getPaths(req.path);
  // we try and read our metadata so we can set the content type on the
  // response
  var mdStream = getReadStream(paths.metadata, {encoding: 'utf8'});
  var dataStream = getReadStream(paths.file);
  var metaData = [];
  mdStream.on('data', function(chunk) { metaData.push(chunk); });
  mdStream.on('end', function(){
    res.set('Content-Type', JSON.parse(metaData.join('')).mimetype);
    dataStream.pipe(res);
  });
  mdStream.on('error', function(){
    // we don't have a content type stored for whatever reason, so 
    // we'll just let sendFile do it's thing
    res.set('Content-Type', mime.lookup(paths.file));
    dataStream.pipe(res);
  }); 
  dataStream.on('error', function(e) {
    res.set('Content-Type', 'text/html');
    if ( e.code === 'ENOENT' ){
      res.status(404).send("Resource not found");
    } else {
      log.error(e);
      res.status(500).send("Server error");
    }
  });
  
});


var listenPort = process.env.PORT || 3000;
log.info("starting app " + process.env.APP_NAME);
log.info("listening on " + listenPort);
app.listen(listenPort);
