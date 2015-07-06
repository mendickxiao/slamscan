var async = require('async');
var AWS = require('aws-sdk');
var util = require('util');
var fs = require('fs');
var fse = require('fs-extra');
var config = require('config');
var temp = require('temp');
var path = require('path');
var request = require('request');
var Clamscan = require('clamscan');
var appRoot = require('app-root-path');
var url = require('url');
var validUrl = require('valid-url');
var process = require('child_process');

module.exports = {
  getS3: function() {
    return new AWS.S3();
  },
  getSns: function() {
    return new AWS.SNS();
  },
  downloadClamscanDbFiles: function(callback) {
    var dbFiles = config.get('slamscan.clamscan-db-files');
    async.each(dbFiles, function(dbFile, next) {
      var urlPath = url.parse(dbFile);
      var filename = path.basename(urlPath.pathname);
      var file = path.join('/tmp', filename);
      console.log(file);
      fs.exists(file, function(exists) {
        console.log("%s exists: %s", file, exists);
        if (exists) {
          next();
        } else {
          module.exports.downloadUrlToFile(dbFile, file, function(err) {
            next(err);
          });
        }
      });
    }, function(err) {
      if (err) { console.log(err); }
      callback(err);
    });
  },
  manualScan: function(file, callback) {
    var exe = '/var/task/bin/clamscan';
    var tmpExe = '/tmp/clamscan';
    async.waterfall([
      function(next) {
        fs.exists(tmpExe, function(exists) {
          console.log("%s exists: %s", tmpExe, exists);
          if (exists) {
            next();
          } else {
            fse.copy(exe, tmpExe, function(err) {
              next(err);
            });
          }
        });
      },
      function(next) {
        fs.chmod(tmpExe, '755', function(err) {
          next(err);
        });
      },
      function(next) {
        var runCmd = util.format('%s -d /tmp %s', tmpExe, file);
        var v = process.exec(runCmd, function (err, stdout, stderr) {
          var isInfected = false;
          if (err) {
            err = util.format("%s %s %s", err, stdout, stderr);
            isInfected = true;
          }
          next(err, isInfected);
        });
        
      }
    ], function(err, isInfected) {
      if (err) {
        console.log(err);
      }
      callback(err, isInfected);
    });

    /*
	v.on('exit', function (code) {
      var err = null;
      if (code != 0) {
        err = util.format('clamscan returned error code %d', code);
      }
      callback(err);
    });
    */
  },
  getClamscan: function() {
    /*jscs:disable*/
    return new Clamscan({
      remove_infected: false, // If true, removes infected files
      quarantine_infected: false, // False: Don't quarantine, Path: Moves files to this place.
      scan_log: null, // Path to a writeable log file to write scan results into
      debug_mode: true, // Whether or not to log info/debug/error msgs to the console
      file_list: null, // path to file containing list of files to scan (for scan_files method)
      scan_recursively: false, // If true, deep scan folders recursively
      testing_mode: true,
      clamscan: {
        path: '/var/task/bin/clamscan', // Path to clamscan binary on your server
        db: '/tmp', // Path to a custom virus definition database
        scan_archives: true, // If true, scan archives (ex. zip, rar, tar, dmg, iso, etc...)
        active: true // If true, this module will consider using the clamscan binary
      },
      clamdscan: {
        path: null,
        active: false
      },
      preference: 'clamscan' // If clamdscan is found and active, it will be used by default
    });
    /*jscs:enable*/
  },
  downloadUrlToFile: function(downloadUrl, file, callback) {
    /*jscs:disable*/
    if (!validUrl.is_uri(downloadUrl)) {
      /*jscs:enable*/
      return callback(util.format('Error: Invalid uri %s', downloadUrl));
    }

    var urlPath = url.parse(downloadUrl);
    console.info('Downloading %s -> %s', urlPath.pathname, file);
    var fileStream = fs.createWriteStream(file);

    function closeStream() {
      console.log('Finished downloading %s (stream closed)', file);
      callback(null, file);
    }

    fileStream.on('finish', closeStream);

    request.get(downloadUrl).on('error', function(err) {
      console.error('Err downloading %s. Err: %s', downloadUrl, err);
      fileStream.removeListener('finish', closeStream);
      callback(err);
    }).on('response', function(response) {
      if (response.statusCode != 200) {
        console.error('Error downloading %s Code: %d',
          downloadUrl,
          response.statusCode
        );
        fileStream.removeListener('finish', closeStream);
        callback(util.format('Error: status code %d', response.statusCode));
      }
    }).pipe(fileStream);
  },
  download: function(s3, bucket, key, callback) {
    if (!bucket.length || !key.length) {
      return callback(util.format(
        'Error! Bucket: %s and Key: %s must be defined',
        bucket,
        key
      ));
    }
    var ext = path.extname(key);
    var tmpFile = temp.path({suffix: ext});
    console.log('Download src file s3://%s/%s to %s', bucket, key, tmpFile);
    var file = fs.createWriteStream(tmpFile);
    var save = s3.getObject({
      Bucket: bucket,
      Key: key,
    }).createReadStream().pipe(file);
    save.on('close', function() {
      callback(null, tmpFile);
    });
  },
  scan: function(clamscan, file, callback) {
    console.log(file);
    /*jscs:disable*/
    clamscan.is_infected(file, function(err, scannedFile, isInfected) {
      /*jscs:enable*/
      if (err) {
        console.log(err);
      }
      callback(err, scannedFile, isInfected);
    });
  },
  sns: function(sns, topicArn, bucket, key, result, callback) {
    sns.publish({
      TopicArn: topicArn,
      Message: JSON.stringify({
        Bucket: bucket,
        Key: key,
        Result: result,
      }),
    }, function(err, data) {
      if (err) {
        console.log(err);
      }
      callback(err, data);
    });
  },
  handler: function(event, context) {
    console.log('Reading options from event:\n',
      util.inspect(event, {depth: 5})
    );

    if (typeof (event.Records) == 'undefined') {
      console.log('Unable to find event.Records event:%j', event);
      return context.done();
    }

    var topicArn = config.get('slamscan.sns-topic-arn');
    var s3 = module.exports.getS3();
    var sns = module.exports.getSns();

    module.exports.downloadClamscanDbFiles(function(err) {
      if (err) {
        console.log('Failed to download clamscandb files. Exiting');
        return context.done(err);
      }

      // var clamscan = module.exports.getClamscan();  
      async.each(event.Records, function(record, callback) {
        var bucket = record.s3.bucket.name;
        var key = record.s3.object.key;
  
        async.waterfall([
          function(next) {
            console.log("bucket %s key %s", bucket, key);
            module.exports.download(s3, bucket, key, function(err, tmpFile) {
              next(err, tmpFile);
            });
          },
          function(tmpFile, next) {
            /*
            module.exports.scan(
              clamscan,
              tmpFile,
              function(err, file, isInfected) {
                next(err, isInfected);
              }
            );*/
            module.exports.manualScan(
             tmpFile,
             function(err, file, isInfected) {
              next(err, isInfected);
             }
            );
          },
          function(isInfected, next) {
            module.exports.sns(
              sns,
              topicArn,
              bucket,
              key,
              isInfected,
              function(err) {
                next(err);
              }
            );
          },
        ], function(err) {
          callback(err);
        });
      }, function(err) {
        context.done();
      });
    });
  },
};

