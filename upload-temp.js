const multipart = require('parse-multipart');

exports.handler = async (event) => {
    const boundary = multipart.getBoundary(event.headers['content-type']);
    const bodyBuffer = Buffer.from(event.body, 'base64');
    const parts = multipart.Parse(bodyBuffer, boundary);
    
    // Process the parts as needed
    return parts;
};