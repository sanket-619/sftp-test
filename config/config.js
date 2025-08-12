'use strict';

module.exports = {
  // Server configuration
  server: {
    port: process.env.SFTP_PORT || 2222,
    host: process.env.SFTP_HOST || '127.0.0.1',
    maxConnections: process.env.SFTP_MAX_CONNECTIONS || 100
  },

  // SFTP path configuration
  sftp: {
    // Base path for user directories (relative to S3 bucket root)
    userBasePath: process.env.SFTP_USER_BASE_PATH || 'users',
    
    // Default subdirectories to create for each user
    defaultSubdirectories: process.env.SFTP_DEFAULT_SUBDIRS ? 
      process.env.SFTP_DEFAULT_SUBDIRS.split(',') : ['invoices', 'ledgers'],
    
    // Whether to create default subdirectories automatically
    createDefaultSubdirs: process.env.SFTP_CREATE_DEFAULT_SUBDIRS !== 'false'
  },

  // AWS S3 configuration
  s3: {
    bucket: process.env.S3_BUCKET || 'zono-digital-qa-sftp-uploads',
    region: process.env.AWS_REGION || 'ap-south-1',
    maxFileSize: process.env.S3_MAX_FILE_SIZE || 100 * 1024 * 1024 // 100MB
  },

  // Authentication configuration
  auth: {
    // Default username for connections
    defaultUsername: process.env.SFTP_DEFAULT_USER || 'user'
  },

  // Logging configuration
  logging: {
    enabled: process.env.LOGGING_ENABLED !== 'false',
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || null
  },

  // Security configuration
  security: {
    // Allowed file extensions (empty array means all allowed)
    allowedExtensions: process.env.ALLOWED_EXTENSIONS ? 
      process.env.ALLOWED_EXTENSIONS.split(',') : [],
    
    // Blocked file extensions
    blockedExtensions: process.env.BLOCKED_EXTENSIONS ? 
      process.env.BLOCKED_EXTENSIONS.split(',') : ['.exe', '.bat', '.sh'],
    
    // Maximum directory depth
    maxDirectoryDepth: process.env.MAX_DIRECTORY_DEPTH || 10
  }
}; 