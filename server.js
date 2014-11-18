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

config = {
  storageRoot: process.env.STORAGE_ROOT || path.join(__dirname, 'files')
};
config.usingS3 = config.storageRoot.indexOf("s3://") === 0;

// the s3:// is not required in the bucket name, it's just a 
// convenient way of telling that we're using s3, so we'll 
// strip it if appropriate
if (config.usingS3){
  config.storageRoot = config.storageRoot.replace(/s3:\/\//,"");
  log.debug("using s3, bucket: ", config.storageRoot);
}


function getPaths(fileName) {
  var filePath = path.join(config.storageRoot, fileName);
  var basename = path.basename(filePath);
  var metaDataFilePath = path.join(config.storageRoot, "." + basename + ".md");
  return {
    dirname: path.dirname(filePath),
    basename: basename,
    file: filePath,
    metadata: metaDataFilePath,
    fileName: fileName
  };
}

function getFSWriteStream(fileName){
  return fs.createWriteStream(fileName, {flags: "wx"});
}
function getFSReadStream(fileName){
  return fs.createReadStream(fileName);
}

function getS3WriteStream(fileName){
  var client = s3Stream(new AWS.S3());
  var options = {Bucket:config.storageRoot, Key:getObjectKeyFromPath(fileName)};
  log.debug("getWriteStream options: ", options);
  var uploadStream = client.upload(options);
  return uploadStream;
}
function getS3ReadStream(fileName){
  var s3 = new AWS.S3();
  var options = {Bucket:config.storageRoot, Key:getObjectKeyFromPath(fileName)};
  log.debug("getObject options: ", options);
  return s3.getObject(options).createReadStream();
}

function getObjectKeyFromPath(filePath){
  // remove the bucket name, since that's independent of 
  // the object key in s3 calls
  return filePath.replace(config.storageRoot + "/", "");
}
// overwrite our stream methods with s3 specific ones

function checkForObject(paths){
  var s3 = new AWS.S3();
  return new Promise(function(resolve, reject){
    var callback = function(err, data){
      if (err) { 
        if (err.statusCode === 403 || err.statusCode === 404){
          // ironically, head returns a 403 if you ask for
          // something that doesn't exist as well as 404
          resolve(paths);
        } else {
          reject(err);
        }
      } else {
        paths.headResult = data;
        resolve(paths);
      }
    };
    var options = {Bucket:config.storageRoot, Key:getObjectKeyFromPath(paths.file)};
    log.debug("checkForObject options: ", options);
    s3.headObject(options ,callback);
  });
}

function raiseIfObjectExists(paths){
  log.debug("raiseIfObjectExists");
  if (paths.headResult){
    var e = new Error("FileExists");
    e.code = "EEXIST";
    throw e;
  }
  return Promise.resolve(paths);
}
  
if (config.usingS3){
  var getWriteStream = getS3WriteStream;
  var getReadStream = getS3ReadStream;
} else {
  var getWriteStream = getFSWriteStream;
  var getReadStream = getFSReadStream;
}

function makeDirectories(paths){
  // mkdirp returns the name of the directory we created, but
  // we really want paths as our return so everyone can use it  
  return mkdirp.mkdirpAsync(paths.dirname).return(paths);
}

function FileExists(e) { return e.code === "EEXIST"; }

function storeMultipartRequestData(req, res){
  return function doStore(paths){
    req.busboy.on('finish', function(){ res.end(); });
    // write files
    req.busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
      file.pipe(getWriteStream(path.join(config.storageRoot, path.dirname(paths.fileName), filename)));
    });
    req.pipe(req.busboy);
  };
}

function storeRawRequestData(req, res){
  return function doStore(paths){
    var metaDataFileStream = getWriteStream(paths.metadata);
    var metaDataFileSaved = new Promise(function(resolve, reject){
      metaDataFileStream.on('close', resolve);
      metaDataFileStream.on('error', reject);
    });
    metaDataFileStream.write(
      JSON.stringify({mimetype:req.get('Content-Type')}),
      function() { if (metaDataFileStream.close) {metaDataFileStream.close(); }}
    );

    dataFileStream = getWriteStream(paths.file);
    dataFileSaved = new Promise(function(resolve, reject){
      dataFileStream.on('close', resolve);
      dataFileStream.on('error', reject);
    }); 
    req.pipe(dataFileStream);
    return Promise.join(metaDataFileSaved, dataFileSaved);
  };
}

var app = express();

app.use(connect());
app.use(morgan('combined'));
app.use(busboy());

app.post('*', function(req, res){
  var storeRequestData = null;
  var storeIt = null;

  if (req.is('multipart/form-data')){
    log.debug("multi part request");
    storeRequestData = storeMultipartRequestData(req, res);
  } else {
    storeRequestData = storeRawRequestData(req, res);
  }

  if (config.usingS3) {
    log.debug("using s3 bucket ", config.storageRoot);
    storeIt = Promise
    .resolve(getPaths(req.path))
    .then(checkForObject)
    .then(raiseIfObjectExists)
    .then(storeRequestData);
  } else {
    log.debug("using local filesystem", config.storageRoot);
    storeIt = Promise
    .resolve(getPaths(req.path))
    .then(makeDirectories)
    .then(storeRequestData);
  }

  storeIt
  .then(function(){ res.end(); })
  .catch(FileExists, function(e){ res.status(403).send("File exists"); })
  .catch(function(e){
    log.error("error writing file: %j", e);
    log.error(e.stack);
    res.status(500).send(e);
  });
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
    if ( e.code === 'ENOENT' || e.statusCode === 404 ){
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
log.debug("Debug logging enabled");
app.listen(listenPort);
