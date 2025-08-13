'use strict';

const { S3Client } = require('@aws-sdk/client-s3');
const SFTPS3Server = require('./server');
const config = require('../config/config');

// Create S3 client with AWS SDK v3 using AWS CLI credentials
const s3Client = new S3Client({
  region: config.s3.region
});

// Create SFTP server instance
const sftpServer = new SFTPS3Server(s3Client, config.s3.bucket);

// Enable logging if configured
if (config.logging.enabled) {
  sftpServer.enableLogging();
}

// Event handlers
sftpServer.on('login', (data) => {
  console.log(`User ${data.username} logged in`);
});

sftpServer.on('client-error', (data) => {
  console.error('Client error:', data.error);
});

sftpServer.on('client-disconnected', (data) => {
  console.log(`User ${data.username} disconnected`);
});

sftpServer.on('file-uploaded', (data) => {
  console.log(`File uploaded: ${data.path} by ${data.username}`);
});

sftpServer.on('upload-error', (data) => {
  console.error(`Upload error: ${data.path} by ${data.username} - ${data.error.message}`);
});

sftpServer.on('protected-directory-deletion-blocked', (data) => {
  console.warn(`Protected directory deletion blocked: ${data.path} by ${data.username}`);
});

sftpServer.on('protected-directory-rename-blocked', (data) => {
  console.warn(`Protected directory rename blocked: ${data.oldPath} -> ${data.newPath} by ${data.username}`);
});

sftpServer.on('directory-creation-blocked', (data) => {
  console.warn(`Directory creation blocked: ${data.path} by ${data.username}`);
});

sftpServer.on('directory-deletion-blocked', (data) => {
  console.warn(`Directory deletion blocked: ${data.path} by ${data.username}`);
});

sftpServer.on('directory-changed', (data) => {
  console.log(`Directory changed: ${data.path} - ${data.action} ${data.filename} by ${data.username}`);
});

sftpServer.on('file-downloaded', (data) => {
  console.log(`File downloaded: ${data.path} by ${data.username}`);
});

sftpServer.on('file-deleted', (data) => {
  console.log(`File deleted: ${data.path} by ${data.username}`);
});

sftpServer.on('directory-created', (data) => {
  console.log(`Directory created: ${data.path} by ${data.username}`);
});

sftpServer.on('directory-deleted', (data) => {
  console.log(`Directory deleted: ${data.path} by ${data.username}`);
});

sftpServer.on('file-renamed', (data) => {
  console.log(`File renamed: ${data.oldPath} -> ${data.path} by ${data.username}`);
});

// Start the server
sftpServer.listen(config.server.port, config.server.host, (port) => {
  console.log(`SFTP server listening on ${config.server.host}:${port}`);
  console.log(`S3-based authentication enabled`);
  console.log(`S3 Bucket: ${config.s3.bucket}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down SFTP server...');
  sftpServer.stop(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\nShutting down SFTP server...');
  sftpServer.stop(() => {
    console.log('Server stopped');
    process.exit(0);
  });
}); 