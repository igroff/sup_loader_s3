### 'sup Loader

#### What?

The important thing here is a consistent interface for uploading and 
retrieval of files.  It's designed to allow upload, and provide a 
efficient retrieval of files.

### Configuration

All of the configuration of this thing is done via environment variables
and the following are required.

* `BUCKET` - The name of the S3 bucket where any POSTed files will be
stored, and from which GETed(?) files will be retrieved.
* `AWS_ACCESS_KEY_ID & AWS_SECRET_ACCESS_KEY` - The AWS credentials allowing
access to the BUCKET provided.

#### Interface

The root of this interface is the name of the file so...

##### GET /\<file name\>

Retrieves the file specified by <file_name>, returning the appropriate 
mimetype for the file.

##### POST /\<file name\> 
Stores data provided in the request as \<file name\>.

There are two ways to POST data to the api; as a multi-part request
or not.

If data is POSTed as a multi-part upload then the file name
is taken from the name of the file within the multi-part data and
(upon retrieval) the mime-type is inferred from the file name.

If the data is posted in any other encoding, the data is stored as-is
from the request and the content type (which will be used as the
content-type in any subsquent GET request) is taken from the request.
That is to say that you can specify any arbitrary content type value
when the initial POST of data is made, and that will be preserved and
provided as the content type of the response when the data is subsequently
requested via GET.

Once the data is successfully stored, a response of status 200 will
be returned to the caller

Any attempts to write data over an existing file will fail, returning
a 403 to the caller.

##### DELETE /\<file name\>
Removes the file (if any) specified by \<file name\>.

In the event of successful deletion of the specified file, a response
of status 200 will be returned to the caller.

In the case of a DELETE of a non-existant file being requested, a 
response of status 404 will be returned to the caller.

#### Tests

* `simple_upload` - proves that a post of data as 'form data' (content-type = application/x-www-form-urlencoded) is returned as uploaded with the that (application/x-www-form-urlencoded) content type.
* `cannot_overwrite` - proves that attempts to upload a file 'over' an existing file results in a 403.
* `mime_type` - proves that a file uploaded without a content type is given a content type based on the filename when subsequently requested.
* `put_with_content_type` - proves that the content type provided when the POST is performed is subsequently returned when the file is requested.
* `sub_path` - proves that uploads with sub paths in the file name are handled and the file is returned appropriately. 
* `test_404` - proves that the interface will return a 404 when a request ( GET ) is made for a file that doesn't exist.
