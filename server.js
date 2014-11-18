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
}

var app = express();

app.use(connect());
app.use(morgan('combined'));
app.use(busboy());

function getPaths(fileName) {
  var filePath = path.join(config.storageRoot, fileName);
  var basename = path.basename(filePath);
  var metaDataFilePath = path.join(config.storageRoot, "." + basename + ".md");
  return {dirname: path.dirname(filePath), basename: basename, file: filePath, metadata: metaDataFilePath};
}

function getWriteStream(fileName){
  return fs.createWriteStream(fileName, {flags: "wx"});
}
function getReadStream(fileName){
  return fs.createReadStream(fileName);
}

if (config.usingS3){
  // overwrite our stream methods with s3 specific ones
  function getWriteStream(fileName){
    var client = s3Stream(new AWS.S3());
    var uploadStream = client.upload({Bucket:config.storageRoot, Key:fileName});
    uploadStream.on('error', log.error);
    return uploadStream;
  }
  function getReadStream(fileName){
    var s3 = new AWS.S3();
    s3.getObject({Bucket:config.storageRoot, Key:fileName}).createReadStream();
  }
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
    function storeRequestData(paths){
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
      return Promise.join(metaDataFileSaved, dataFileSaved);
    }

    function makeDirectories(paths){
      // mkdirp returns the name of the directory we created, but
      // we really want paths as our return so everyone can use it  
      return mkdirp.mkdirpAsync(paths.dirname).return(paths);
    };

    // exception predicate 
    function FileExists(e) { return e.code === "EEXIST"; }

    if (config.usingS3){
      Promise
      .resolve(getPaths(req.path))
      .then(storeRequestData)
      .then(function(){ res.end(); })
      .catch(FileExists, function(e){ res.status(403).send("File exists"); })
      .catch(function(e){
        log.error("error writing file: %j", e);
        log.error(e.stack);
        res.status(500).send(e);
      });
    } else {
      Promise
      .resolve(getPaths(req.path))
      .then(makeDirectories)
      .then(storeRequestData)
      .then(function(){ res.end(); })
      .catch(FileExists, function(e){ res.status(403).send("File exists"); })
      .catch(function(e){
        log.error("error writing file: %j", e);
        log.error(e.stack);
        res.status(500).send(e);
      });
    }
    
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
