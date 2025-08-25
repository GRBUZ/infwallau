// Updated code to fix multipart parsing by decoding base64 body correctly

const uploadTemp = async (event) => {
    const body = event.body;
    const decodedBody = Buffer.from(body, 'base64'); // Decoding base64 body

    // Further processing of decodedBody...

    return { statusCode: 200, body: 'Upload successful!' };
};

exports.handler = uploadTemp;