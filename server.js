var AWS             = require('aws-sdk');
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
var mkdirp          = Promise.promisifyAll(require('mkdirp'));
var s3Stream        = require('s3-upload-stream');

config = { bucket: process.env.BUCKET };

function getWriteStream(objectKey){
  var client = s3Stream(new AWS.S3());
  var options = {Bucket:config.bucket, Key:objectKey};
  log.debug("getWriteStream options: ", options);
  var uploadStream = client.upload(options);
  return uploadStream;
}

function keyFromPath(path){
  if (path.indexOf("/") === 0){
    return path.substring(1);
  }
  return path;
}

function checkForObject(objectKey){
  var s3 = new AWS.S3();
  return new Promise(function(resolve, reject){
    var callback = function(err, data){
      if (err) { 
        if (err.statusCode === 403 || err.statusCode === 404){
          // ironically, head returns a 403 if you ask for
          // something that doesn't exist as well as 404
          resolve(false);
        } else {
          reject(err);
        }
      } else {
        reject(new Error("FileExists"));
      }
    };
    var options = {Bucket:config.bucket, Key:objectKey};
    log.debug("checkForObject options: ", options);
    s3.headObject(options ,callback);
  });
}
  
function FileExists(e) { return e.message === "FileExists"; }

function storeMultipartRequestData(req, res){
  return function doStoreMultipart(paths){
    log.debug('storeMultipartRequestData');
    req.busboy.on('finish', function(){ res.end(); });
    // write files
    req.busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
      file.pipe(getWriteStream(path.join(config.bucket, path.dirname(paths.fileName), filename)));
    });
    req.pipe(req.busboy);
  };
}

function storeRawRequestData(req, res){
  return function doStoreRaw(){
    log.debug('storeRawRequestData');
    var client = s3Stream(new AWS.S3());
    var options = {Bucket:config.bucket,
      Key: keyFromPath(req.path),
      Metadata: {ContentType: req.get('Content-Type')}};
    // this is just for testing and allows us to skip the writing of the 
    // content type so that we can trigger the outbound 'auto detection' of
    // content type based on the file name
    if (req.param("nomd")){
      delete(options.Metadata.ContentType);
    }
    log.debug("s3 options: %j", options);
    var uploadStream = client.upload(options);
    dataFileSaved = new Promise(function(resolve, reject){
      uploadStream.on('uploaded', resolve);
      uploadStream.on('error', reject);
    }); 
    req.pipe(uploadStream);
    return dataFileSaved;
  };
}

var app = express();

app.use(connect());
app.use(morgan('combined'));
app.use(busboy());

app.post('*', function(req, res){
  var storeRequestData = null;

  if (req.is('multipart/form-data')){
    log.debug("multi part request");
    storeRequestData = storeMultipartRequestData(req, res);
  } else {
    storeRequestData = storeRawRequestData(req, res);
  }

  Promise
  .resolve(keyFromPath(req.path))
  .then(checkForObject)
  .then(storeRequestData)
  .then(function(){ res.end(); })
  .catch(FileExists, function(e){ res.status(403).send("File exists"); })
  .catch(function(e){
    log.error("error writing file: %j", e);
    log.error(e.stack);
    res.status(500).send(e);
  });
});

app.get('*', function(req, res){
  var s3 = new AWS.S3();
  var options = {Bucket:config.bucket, Key:keyFromPath(req.path)};
  log.debug("getObject options: ", options);
  s3.headObject(options, function(err, data){
    if (err) {
      if (err.statusCode === 404){
        res.status(404).send("Resource not found");
      } else {
        log.error(err);
      }
    } else {
      /// nice the 'string map' of metadata is lowercased for us... helpful
      var contentType = (data.Metadata && data.Metadata.contenttype) ||
        mime.lookup(options.Key);
      log.debug("Metdata: %j", data.Metadata);
      res.set('Content-Type', contentType);
      s3.getObject(options).createReadStream().pipe(res);
    }
  });
});

app.delete('*', function(req, res){
  var s3 = new AWS.S3();
  var options = {Bucket:config.bucket, Key:keyFromPath(req.path)};
  s3.deleteObject(options, function(err, data){
    res.status((err && err.statusCode) || 200).send(err || null);
  });
});

if (!config.bucket){
  log.error("invalid configuration, no bucket specified");
  process.exit(1);
}

var listenPort = process.env.PORT || 3000;
log.info("starting app " + process.env.APP_NAME);
log.info("listening on " + listenPort);
log.debug("Debug logging enabled");
app.listen(listenPort);
