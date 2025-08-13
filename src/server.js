'use strict';
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { Server } = require('ssh2');
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, HeadObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const util = require('util');
const config = require('../config/config');
const accessControl = require('../config/access-control');

// SFTP Constants
const SFTP_STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8
};

const SFTP_OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREATE: 0x00000008,
  TRUNCATE: 0x00000010,
  EXCLUDE: 0x00000020
};

class SFTPS3Server extends EventEmitter {
  constructor(s3Client, bucketName) {
    super();
    this.s3Client = s3Client;
    this.bucketName = bucketName;
    this.loggingEnabled = false;
    this.ssh = null;
    this.lastUploadTime = 0; // Track when files were uploaded
    
    // Use access control configuration
    this.accessControl = accessControl;
    
    // Track user connections and their activity
    this.userConnections = new Map(); // Map to track user connections
    this.idleTimers = new Map(); // Map to track idle timers for each user
  }

  /**
   * Enables logging to standard output
   */
  enableLogging() {
    this.loggingEnabled = true;
  }

  /**
   * Disables logging
   */
  disableLogging() {
    this.loggingEnabled = false;
  }

  /**
   * Track user activity and reset idle timer
   * @param {string} username - The username
   */
  _trackUserActivity(username) {
    if (!username) return;
    
    // Clear existing idle timer for this user
    if (this.idleTimers.has(username)) {
      clearTimeout(this.idleTimers.get(username));
    }
    
    // Set new idle timer for 1 minute (60000 ms)
    const idleTimer = setTimeout(() => {
      this._handleIdleConnection(username);
    }, 60000);
    
    this.idleTimers.set(username, idleTimer);
    
    // Update last activity time
    this.userConnections.set(username, {
      lastActivity: Date.now(),
      connectionTime: this.userConnections.get(username)?.connectionTime || Date.now()
    });
    
    this._log(util.format('User activity tracked for %s at %s', username, new Date().toISOString()));
  }

  /**
   * Handle idle connection for a user
   * @param {string} username - The username
   */
  _handleIdleConnection(username) {
    this._log(util.format('User %s connection is idle for 1 minute - performing idle operation', username));
    
    // Perform idle operation - print message
    console.log(`🚫 IDLE CONNECTION: User ${username} has been idle for 1 minute`);
    
    // Emit idle event
    this.emit('user-idle', { username: username, timestamp: Date.now() });
    
    // Clean up timer
    this.idleTimers.delete(username);
  }

  /**
   * Clean up user connection tracking
   * @param {string} username - The username
   */
  _cleanupUserConnection(username) {
    if (!username) return;
    
    // Clear idle timer
    if (this.idleTimers.has(username)) {
      clearTimeout(this.idleTimers.get(username));
      this.idleTimers.delete(username);
    }
    
    // Remove from user connections
    this.userConnections.delete(username);
    
    this._log(util.format('Cleaned up connection tracking for user %s', username));
  }

  /**
   * Handle client disconnect events
   * @param {string} username - The username
   * @param {string} eventType - Type of disconnect event
   */
  _handleClientDisconnect(username, eventType) {
    if (!username) return;
    
    this._log(util.format('Client disconnected for user: %s (event: %s)', username, eventType));
    
    // Print disconnect message with user ID
    console.log(`👋 Client disconnected for userId: ${username} (${eventType})`);
    
    // Clean up user connection tracking
    this._cleanupUserConnection(username);
    
    // Emit disconnect event
    this.emit('client-disconnected', { username: username, eventType: eventType });
  }

  /**
   * Force disconnect a specific user
   * @param {string} username - The username to disconnect
   * @returns {boolean} - True if user was found and disconnected, false otherwise
   */
  forceDisconnectUser(username) {
    if (!username) return false;
    
    this._log(util.format('Force disconnecting user: %s', username));
    
    // Find and close the client connection for this user
    if (this.ssh && this.ssh.clients) {
      for (const client of this.ssh.clients) {
        if (client.authenticatedUser && client.authenticatedUser.username === username) {
          this._log(util.format('Found client for user %s, closing connection', username));
          client.end();
          return true;
        }
      }
    }
    
    // If no active client found, just clean up tracking
    this._cleanupUserConnection(username);
    this._log(util.format('No active client found for user %s, cleaned up tracking', username));
    
    return false;
  }

  /**
   * Get list of active user connections
   * @returns {Array} - Array of active user connection info
   */
  getActiveConnections() {
    const connections = [];
    
    if (this.ssh && this.ssh.clients) {
      for (const client of this.ssh.clients) {
        if (client.authenticatedUser) {
          const username = client.authenticatedUser.username;
          const connectionInfo = this.userConnections.get(username);
          
          connections.push({
            username: username,
            connectionTime: connectionInfo?.connectionTime || Date.now(),
            lastActivity: connectionInfo?.lastActivity || Date.now(),
            idleTime: Date.now() - (connectionInfo?.lastActivity || Date.now())
          });
        }
      }
    }
    
    return connections;
  }

  /**
   * Disconnect all users
   * @returns {number} - Number of users disconnected
   */
  disconnectAllUsers() {
    let disconnectedCount = 0;
    
    if (this.ssh && this.ssh.clients) {
      for (const client of this.ssh.clients) {
        if (client.authenticatedUser) {
          const username = client.authenticatedUser.username;
          this._log(util.format('Disconnecting user: %s', username));
          client.end();
          disconnectedCount++;
        }
      }
    }
    
    // Clean up all tracking
    this.idleTimers.clear();
    this.userConnections.clear();
    
    this._log(util.format('Disconnected %d users and cleaned up tracking', disconnectedCount));
    return disconnectedCount;
  }

  /**
   * Starts the SFTP server listening
   * @param {number} port - Port to listen on
   * @param {string} bindAddress - Address to bind to
   * @param {Function} [callback] - Callback when server starts
   */
  listen(port, bindAddress, callback) {
    if (this.ssh) {
      throw new Error('Server is already running');
    }

    // Load the server host key
    const serverKeyPath = path.join(__dirname, '..', 'keys', 'server_key_rsa');
    const serverKey = fs.readFileSync(serverKeyPath);

    this.ssh = new Server({
      hostKeys: [serverKey],
      authMethods: ['password']
    });

    this.ssh.on('connection', (client) => {
      let authenticatedUser = null;

      client.on('error', (err) => {
        this.emit('client-error', { client: client, error: err });
      });

      client.on('authentication', async (ctx) => {
        try {
          if (ctx.method === 'password') {
            // Handle password authentication
            const isAuthenticated = await this._authenticateUser(ctx.username, ctx.password);
            if (isAuthenticated) {
              // Create user-specific folder if it doesn't exist
              await this._ensureUserDirectory(ctx.username);
              
              authenticatedUser = {
                username: ctx.username,
                path: `${config.sftp.userBasePath}/${ctx.username}` // Set user-specific base path
              };
              this._log(util.format('User %s authenticated successfully with base path: %s', ctx.username, authenticatedUser.path));
              return ctx.accept();
            } else {
              this._log(util.format('Authentication failed for user %s', ctx.username));
              return ctx.reject(['password'], false);
            }
          } else if (ctx.method === 'publickey') {
            // Handle public key authentication if needed
            this._log(util.format('Public key authentication not implemented for user %s', ctx.username));
            return ctx.reject(['password'], false);
          } else if (ctx.method === 'none') {
            // Reject none authentication method
            this._log(util.format('Rejecting none authentication method for user %s', ctx.username));
            return ctx.reject(['password'], false);
          } else {
            // Only allow password authentication
            this._log(util.format('Unsupported authentication method: %s', ctx.method));
            return ctx.reject(['password'], false);
          }
        } catch (error) {
          this._log(util.format('Authentication error for user %s: %s', ctx.username, error.message));
          return ctx.reject(['password'], false);
        }
      });

      client.on('ready', () => {
        this._log(util.format('Client authenticated as %s', authenticatedUser.username));
        this.emit('login', { username: authenticatedUser.username });

        // Start tracking user activity
        this._trackUserActivity(authenticatedUser.username);

        client.on('session', (accept, reject) => {
          const session = accept();
          
          session.on('sftp', (accept, reject) => {
            const sftp = accept();
            const openFiles = new Map();
            const openDirs = new Map();
            let handleCount = 0;

            // Handle SFTP operations
            this._setupSFTPHandlers(sftp, openFiles, openDirs, handleCount, authenticatedUser);
          });

          // Handle session close
          session.on('close', () => {
            const username = authenticatedUser?.username;
            this._log(util.format('Session close event for user: %s', username));
            this._handleClientDisconnect(username, 'session-close');
          });
        });
      });

      // Handle client disconnect events
      client.on('end', () => {
        const username = authenticatedUser?.username;
        this._log(util.format('Client end event for user: %s', username));
        this._handleClientDisconnect(username, 'end');
      });

      client.on('close', () => {
        const username = authenticatedUser?.username;
        this._log(util.format('Client close event for user: %s', username));
        this._handleClientDisconnect(username, 'close');
      });

      client.on('error', (err) => {
        const username = authenticatedUser?.username;
        this._log(util.format('Client error event for user %s: %s', username, err.message));
        this._handleClientDisconnect(username, 'error');
      });
    });

    this.ssh.listen(port, bindAddress, () => {
      this._log(util.format('SFTP server listening on %s:%d', bindAddress, port));
      if (callback) {
        callback(port);
      }
    });
  }

  /**
   * Stop the server
   * @param {Function} cb - Callback when server stops
   */
  stop(cb) {
    // Clean up all idle timers
    for (const [username, timer] of this.idleTimers) {
      clearTimeout(timer);
      this._log(util.format('Cleaned up idle timer for user %s', username));
    }
    this.idleTimers.clear();
    this.userConnections.clear();
    
    if (this.ssh) {
      this.ssh.close(cb);
      this.ssh = null;
    } else {
      process.nextTick(cb);
    }
  }

  //------------------------- Private Methods -------------------------------------

  _log(...args) {
    if (this.loggingEnabled) {
      console.log.apply(console, args);
    }
  }

  /**
   * Check if a file type is allowed for upload
   * @param {string} filename - The filename to check
   * @returns {boolean} - True if file type is allowed
   */
  _isFileTypeAllowed(filename) {
    // Only allow PDF files for ledgers and invoices directories
    const lowerFilename = filename.toLowerCase();
    
    // Check if this is a path to ledgers or invoices directory
    if (lowerFilename.startsWith('/ledgers/') || lowerFilename.startsWith('/invoices/') ||
        lowerFilename === '/ledgers' || lowerFilename === '/invoices') {
      
      // For ledgers and invoices, only allow PDF files
      if (!lowerFilename.endsWith('.pdf')) {
        this._log(util.format('File type not allowed in ledgers/invoices: %s (only PDF files allowed)', filename));
        return false;
      }
      
      // Also check for empty or invalid filenames
      if (lowerFilename === '/ledgers' || lowerFilename === '/invoices' ||
          lowerFilename === '/ledgers/' || lowerFilename === '/invoices/' ||
          lowerFilename.endsWith('/ledgers/') || lowerFilename.endsWith('/invoices/')) {
        this._log(util.format('Cannot upload to directory path: %s (must specify filename)', filename));
        return false;
      }
    }
    
    // Allow all other file types in other directories
    return true;
  }



  _mapKey(userPath, filename) {
    // Ensure userPath is defined - default to users directory if not set
    if (!userPath) {
      userPath = 'users';
    }
    
    let p = filename;
    p = p.replace(/\\\\/g, '/');
    p = p.replace(/\\.\\/g, '/');
    p = p.replace(/\\/g, '/');
    p = path.normalize(p);
    p = p.replace(/\\/g, '/');
    
    if (!p.startsWith('/')) {
      p = '/' + p;
    }
    
    // Handle direct access to ledgers and invoices folders
    // If user tries to access /ledgers, map it to /users/username/ledgers
    if (p === '/ledgers' || p === '/invoices') {
      // Extract username from userPath (userPath format: users/username)
      const pathParts = userPath.split('/');
      if (pathParts.length >= 2) {
        const username = pathParts[1];
        return `${userPath}${p}`;
      }
    }
    
    return userPath + p;
  }

  _setupSFTPHandlers(sftp, openFiles, openDirs, handleCount, user) {
    // NOTE: Directory creation (MKDIR) and deletion (RMDIR) are DISABLED for all users
    // Users can only upload/download files to existing directories
    // System directories are created automatically during user authentication
    
    // Ensure user object is valid
    if (!user || !user.username) {
      this._log('Invalid user object in SFTP handlers');
      return;
    }
      
      // Ensure user has a path property set to their user-specific directory
      if (!user.path) {
        user.path = `${config.sftp.userBasePath}/${user.username}`;
        this._log(util.format('Set user-specific path for user %s: %s', user.username, user.path));
      }

      // Track user activity for any SFTP operation
      this._trackUserActivity(user.username);
    
    // OPEN - Handle file opening
    sftp.on('OPEN', (reqid, filename, flags, attrs) => {
      // Track user activity
      this._trackUserActivity(user.username);
      
      this._log(util.format('SFTP OPEN filename=%s flags=%d', filename, flags));
      
      if (filename.endsWith('\\') || filename.endsWith('/')) {
        filename = filename.substring(0, filename.length - 1);
      }
      
      // Check access control
      if (!this._isPathAllowed(user.username, filename)) {
        this._log(util.format('Access denied for user %s to file: %s', user.username, filename));
        this._log(util.format('User path: %s, Filename: %s', user.path, filename));
        this._log(util.format('Allowed paths for user %s: %s', user.username, this.accessControl.getAllowedPaths(user.username).join(', ')));
        sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
        return;
      }
      
      // Check file type restrictions for ledgers and invoices directories
      if (flags & SFTP_OPEN_MODE.WRITE) {
        if (!this._isFileTypeAllowed(filename)) {
          this._log(util.format('File type not allowed for user %s: %s', user.username, filename));
          sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
          return;
        }
      }
      
      const fullname = this._mapKey(user.path, filename);

      // Check if this is a directory first
      this._checkIfDirectory(fullname).then(isDirectory => {
        if (isDirectory) {
          this._log(util.format('Cannot open directory %s as file', filename));
          sftp.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
          return;
        }

        if (flags & SFTP_OPEN_MODE.READ) {
          this._handleFileOpenRead(sftp, reqid, filename, fullname, flags, openFiles, handleCount++, user);
        } else if (flags & SFTP_OPEN_MODE.WRITE) {
          this._handleFileOpenWrite(sftp, reqid, filename, fullname, flags, openFiles, handleCount++, user);
        } else {
          this._log('Unsupported operation');
          sftp.status(reqid, SFTP_STATUS_CODE.OP_UNSUPPORTED);
        }
      }).catch(err => {
        this._log(util.format('Error checking if directory: %s', err));
        sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      });
    });

    // READ - Handle file reading
    sftp.on('READ', (reqid, handle, offset, length) => {
      // Track user activity
      this._trackUserActivity(user.username);
      
      if (handle.length !== 4) {
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }
      
      const handleId = handle.readUInt32BE(0, true);
      this._log(util.format('SFTP READ handle=%d offset=%d length=%d', handleId, offset, length));
      
      const state = openFiles.get(handleId);
      if (!state || !(state.flags & SFTP_OPEN_MODE.READ)) {
        this._log('Invalid flags');
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }

      this._log(util.format('File state: size=%d, read=%s', state.size, state.read));

      if (state.read) {
        this._log('EOF');
        return sftp.status(reqid, SFTP_STATUS_CODE.EOF);
      }

      // Check if offset is beyond file size
      if (offset >= state.size) {
        this._log(util.format('Invalid offset: %d >= %d', offset, state.size));
        return sftp.status(reqid, SFTP_STATUS_CODE.EOF);
      }

      // Adjust length if it would read beyond file size
      if (offset + length > state.size) {
        length = state.size - offset;
      }

      if (length === 0) {
        this._log('Zero length read');
        return sftp.status(reqid, SFTP_STATUS_CODE.EOF);
      }

      // Mark as EOF if this read reaches the end
      if (offset + length >= state.size) {
        state.read = true;
      }

      this._readFileFromS3(sftp, reqid, state.fullname, offset, length, user);
    });

    // WRITE - Handle file writing
    sftp.on('WRITE', (reqid, handle, offset, data) => {
      // Track user activity
      this._trackUserActivity(user.username);
      
      if (handle.length !== 4) {
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }
      
      const handleId = handle.readUInt32BE(0, true);
      this._log(util.format('SFTP WRITE handle=%d offset=%d', handleId, offset));

      const state = openFiles.get(handleId);
      if (!state || !(state.flags & SFTP_OPEN_MODE.WRITE)) {
        this._log('Invalid flags');
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }

      state.stream.write(Buffer.from(data), (err) => {
        if (err) {
          this._log('Error writing to stream');
          return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
        }

        this._log('Wrote bytes to stream');
        sftp.status(reqid, SFTP_STATUS_CODE.OK);
      });
    });

    // OPENDIR - Handle directory opening
    sftp.on('OPENDIR', (reqid, dirPath) => {
      // Track user activity
      this._trackUserActivity(user.username);
      
      this._log(util.format('SFTP OPENDIR %s', dirPath));
      
      // Check access control
      if (!this._isPathAllowed(user.username, dirPath)) {
        this._log(util.format('Access denied for user %s to directory: %s', user.username, dirPath));
        sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
        return;
      }
      
      const fullname = this._mapKey(user.path, dirPath);
      const isRoot = (dirPath === '/');

      this._openDirectory(sftp, reqid, fullname, isRoot, openDirs, handleCount++, user);
    });

    // READDIR - Handle directory reading
    sftp.on('READDIR', (reqid, handle) => {
      // Track user activity
      this._trackUserActivity(user.username);
      
      if (handle.length !== 4) {
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }
      
      const handleId = handle.readUInt32BE(0, true);
      this._log(util.format('SFTP READDIR handle=%d', handleId));
      
      const state = openDirs.get(handleId);
      if (!state) {
        this._log('Unknown handle');
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }

      if (state.read) {
        this._log('EOF');
        return sftp.status(reqid, SFTP_STATUS_CODE.EOF);
      }

      state.read = true;
      this._listDirectoryContents(sftp, reqid, state);
    });

    // CLOSE - Handle file/directory closing
    sftp.on('CLOSE', (reqid, handle) => {
      // Track user activity
      this._trackUserActivity(user.username);
      
      if (handle.length !== 4) {
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }
      
      const handleId = handle.readUInt32BE(0, true);
      this._log(util.format('SFTP CLOSE handle=%d', handleId));
      
      const fileState = openFiles.get(handleId);
      const dirState = openDirs.get(handleId);

      if (!fileState && !dirState) {
        this._log('Unknown handle');
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }

      if (fileState) {
        this._closeFile(sftp, reqid, fileState, handleId, openFiles, user);
      } else {
        openDirs.delete(handleId);
        sftp.status(reqid, SFTP_STATUS_CODE.OK);
      }
    });

    // REMOVE - Handle file deletion
    sftp.on('REMOVE', (reqid, filePath) => {
      this._log(util.format('SFTP REMOVE %s', filePath));
      
      // PROTECT IMPORTANT DIRECTORIES - Block deletion of directory structure only
      // Allow users to delete their own files within ledgers and invoices
      if (filePath === '/ledgers' || filePath === '/invoices' || 
          filePath === '/user/ledgers' || filePath === '/user/invoices' ||
          filePath.endsWith('/ledgers/.directory') || filePath.endsWith('/invoices/.directory') ||
          filePath.endsWith('/user/ledgers/.directory') || filePath.endsWith('/user/invoices/.directory')) {
        
        this._log(util.format('User %s attempted to delete protected directory structure %s - BLOCKED', user.username, filePath));
        
        // Reject deletion of protected directory structure
        sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
        
        // Emit event for monitoring
        this.emit('protected-directory-deletion-blocked', { 
          username: user.username, 
          path: filePath, 
          timestamp: Date.now() 
        });
        return;
      }
      
      // Check access control
      if (!this._isPathAllowed(user.username, filePath)) {
        this._log(util.format('Access denied for user %s to remove: %s', user.username, filePath));
        sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
        return;
      }
      
      const fullname = this._mapKey(user.path, filePath);

      this._deleteFileFromS3(sftp, reqid, fullname, user);
    });

    // MKDIR - Handle directory creation (DISABLED)
    sftp.on('MKDIR', (reqid, dirPath, attrs) => {
      this._log(util.format('SFTP MKDIR %s - DIRECTORY CREATION DISABLED', dirPath));
      
      // Reject directory creation with permission denied
      sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
      
      // Log the attempt
      this._log(util.format('User %s attempted to create directory %s - REJECTED', user.username, dirPath));
      
      // Emit event for monitoring
      this.emit('directory-creation-blocked', { 
        username: user.username, 
        path: dirPath, 
        timestamp: Date.now() 
      });
    });

    // RMDIR - Handle directory deletion (DISABLED)
    sftp.on('RMDIR', (reqid, dirPath) => {
      this._log(util.format('SFTP RMDIR %s - DIRECTORY DELETION DISABLED', dirPath));
      
      // Reject directory deletion with permission denied
      sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
      
      // Log the attempt
      this._log(util.format('User %s attempted to delete directory %s - REJECTED', user.username, dirPath));
      
      // Emit event for monitoring
      this.emit('directory-deletion-blocked', { 
        username: user.username, 
        path: dirPath, 
        timestamp: Date.now() 
      });
    });

    // RENAME - Handle file/directory renaming
    sftp.on('RENAME', (reqid, oldPath, newPath) => {
      this._log(util.format('SFTP RENAME %s->%s', oldPath, newPath));
      
      // PROTECT IMPORTANT DIRECTORIES - Block renaming of directory structure only
      // Allow users to rename files within ledgers and invoices
      if (oldPath === '/ledgers' || oldPath === '/invoices' || 
          oldPath === '/user/ledgers' || oldPath === '/user/invoices' ||
          oldPath.endsWith('/ledgers/.directory') || oldPath.endsWith('/invoices/.directory') ||
          oldPath.endsWith('/user/ledgers/.directory') || oldPath.endsWith('/user/invoices/.directory')) {
        
        this._log(util.format('User %s attempted to rename protected directory structure %s - BLOCKED', user.username, oldPath));
        
        // Reject renaming of protected directory structure
        sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
        
        // Emit event for monitoring
        this.emit('protected-directory-rename-blocked', { 
          username: user.username, 
          oldPath: oldPath, 
          newPath: newPath,
          timestamp: Date.now() 
        });
        return;
      }
      
      const fullnameOld = this._mapKey(user.path, oldPath);
      const fullnameNew = this._mapKey(user.path, newPath);

      this._renameInS3(sftp, reqid, fullnameOld, fullnameNew, user);
    });

    // STAT/LSTAT - Handle file/directory stats
    sftp.on('STAT', (reqid, filePath) => {
      this._log(util.format('SFTP STAT %s', filePath));
      
      // Check access control
      if (!this._isPathAllowed(user.username, filePath)) {
        this._log(util.format('Access denied for user %s to stat: %s', user.username, filePath));
        sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
        return;
      }
      
      this._getFileStats(sftp, reqid, filePath, user);
    });

    sftp.on('LSTAT', (reqid, filePath) => {
      this._log(util.format('SFTP LSTAT %s', filePath));
      
      // Check access control
      if (!this._isPathAllowed(user.username, filePath)) {
        this._log(util.format('Access denied for user %s to lstat: %s', user.username, filePath));
        sftp.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
        return;
      }
      
      this._getFileStats(sftp, reqid, filePath, user);
    });

    // REALPATH - Handle path resolution
    sftp.on('REALPATH', (reqid, filePath) => {
      this._log(util.format('SFTP REALPATH %s', filePath));
      this._resolvePath(sftp, reqid, filePath, user);
    });
  }

  // File operations
  async _handleFileOpenRead(sftp, reqid, filename, fullname, flags, openFiles, handleId, user) {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: fullname
      });

      const response = await this.s3Client.send(command);
      const file = response.Contents.find(c => c.Key === fullname);

      if (!file) {
        this._log(util.format('Key %s not found in S3 list', fullname));
        return sftp.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
      }

      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(handleId, 0, true);

      openFiles.set(handleId, {
        flags: flags,
        filename: filename,
        size: file.Size,
        fullname: fullname
      });

      this._log(util.format('File opened: %s, size: %d bytes', fullname, file.Size));

      this._log(util.format('Issuing handle %d', handleId));
      sftp.handle(reqid, handle);
    } catch (err) {
      this._log(util.format('S3 error listing %s: %s', fullname, err));
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }
  }

  _handleFileOpenWrite(sftp, reqid, filename, fullname, flags, openFiles, handleId, user) {
    const stream = new PassThrough();

    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(handleId, 0, true);

    openFiles.set(handleId, {
      flags: flags,
      filename: filename,
      fullname: fullname,
      stream: stream,
      uploadComplete: false,
      uploadError: null
    });

    this._log(util.format('Issuing handle %d', handleId));
    sftp.handle(reqid, handle);

    // Upload to S3
    this._uploadToS3(stream, fullname, handleId, openFiles, user);
  }

  async _readFileFromS3(sftp, reqid, fullname, offset, length, user) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: fullname,
        Range: `bytes=${offset}-${offset + length - 1}`
      });

      const response = await this.s3Client.send(command);
      
      if (!response.Body) {
        this._log(util.format('S3 error getting object %s: empty response', fullname));
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }

      // Convert the readable stream to a Buffer
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) {
        this._log(util.format('S3 error getting object %s: empty buffer', fullname));
        return sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
      }

      this._log(util.format('Successfully read %s (%d bytes)', fullname, buffer.length));
      sftp.data(reqid, buffer);
    } catch (err) {
      this._log(util.format('S3 error getting object %s: %s', fullname, err));
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }
  }

  async _uploadToS3(stream, fullname, handleId, openFiles, user) {
    try {
      // Collect all data from the stream
      const chunks = [];
      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      stream.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          
          // Check for empty files (0 bytes)
          if (buffer.length === 0) {
            this._log(util.format('Empty file upload rejected: %s (0 bytes)', fullname));
            const state = openFiles.get(handleId);
            if (state) {
              state.uploadError = new Error('Empty files are not allowed');
            }
            this.emit('upload-error', { path: fullname, error: new Error('Empty files are not allowed'), username: user.username });
            return;
          }
          
          // Additional validation for ledgers and invoices directories
          const lowerFullname = fullname.toLowerCase();
          if (lowerFullname.includes('/ledgers/') || lowerFullname.includes('/invoices/')) {
            if (!lowerFullname.endsWith('.pdf')) {
              this._log(util.format('Non-PDF file upload rejected in ledgers/invoices: %s', fullname));
              const state = openFiles.get(handleId);
              if (state) {
                state.uploadError = new Error('Only PDF files are allowed in ledgers and invoices directories');
              }
              this.emit('upload-error', { path: fullname, error: new Error('Only PDF files are allowed in ledgers and invoices directories'), username: user.username });
              return;
            }
          }
          
          const command = new PutObjectCommand({
            Bucket: this.bucketName,
            Key: fullname,
            Body: buffer,
            ContentLength: buffer.length
          });

          await this.s3Client.send(command);
          
          const state = openFiles.get(handleId);
          if (state) {
            state.uploadComplete = true;
            this.lastUploadTime = Date.now(); // Mark that a file was uploaded
            this._log(util.format('Successfully uploaded %s', fullname));
            this.emit('file-uploaded', { path: fullname, username: user.username });
            
            // Emit directory change event for upload tracking
            const dirPath = path.dirname(fullname);
            this.emit('directory-changed', { 
              path: dirPath, 
              username: user.username,
              action: 'upload',
              filename: path.basename(fullname)
            });
          }
        } catch (err) {
          const state = openFiles.get(handleId);
          if (state) {
            state.uploadError = err;
          }
          this._log(util.format('S3 error uploading %s: %s', fullname, err));
          this.emit('upload-error', { path: fullname, error: err, username: user.username });
        }
      });

      stream.on('error', (err) => {
        this._log(util.format('Stream error uploading %s: %s', fullname, err));
        this.emit('upload-error', { path: fullname, error: err, username: user.username });
      });
    } catch (err) {
      this._log(util.format('S3 error uploading %s: %s', fullname, err));
      this.emit('upload-error', { path: fullname, error: err, username: user.username });
    }
  }

  // Directory operations
  async _openDirectory(sftp, reqid, fullname, isRoot, openDirs, handleId, user) {
    try {
      // Always get fresh listing from S3 - no caching
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: fullname
      });

      const response = await this.s3Client.send(command);
      const contents = response.Contents || [];
      
      this._log(`Fresh directory listing retrieved for: ${fullname} with ${contents.length} objects`);
      contents.forEach(obj => {
        this._log(`  S3 Object: ${obj.Key} (size: ${obj.Size})`);
      });

      // For root directory, if it's empty, create the user directory
      if (isRoot && contents.length === 0) {
        this._log('Root directory is empty, creating user directory');
        await this._ensureUserDirectory(user.username);
      }

      // If files were uploaded recently, add a small delay and re-fetch to handle S3 consistency
      const timeSinceUpload = Date.now() - this.lastUploadTime;
      if (timeSinceUpload < 10000) { // Within 10 seconds of upload
        this._log('Files uploaded recently, adding delay for S3 consistency');
        // Add a small delay to allow S3 to propagate the changes
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Re-fetch the listing to get the latest files
        const freshCommand = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: fullname
        });
        const freshResponse = await this.s3Client.send(freshCommand);
        const freshContents = freshResponse.Contents || [];
        contents.length = 0; // Clear the old contents
        contents.push(...freshContents); // Add the fresh contents
        this._log(`Fresh listing retrieved with ${freshContents.length} objects after upload delay`);
      }

      if (contents.length === 0 && !isRoot) {
        this._log(util.format('Key %s not found', fullname));
        return sftp.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
      }

      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(handleId, 0, true);

      const listings = this._processDirectoryListings(contents, fullname);
      
      this._log(`Processed ${listings.length} listings for directory: ${fullname}`);
      listings.forEach(listing => {
        this._log(`  - ${listing.Key} (${listing.IsDir ? 'dir' : 'file'})`);
      });
      
      openDirs.set(handleId, {
        fullname: fullname,
        listings: listings,
        user: user // Store user info for access control
      });

      this._log(util.format('Issuing handle %d', handleId));
      sftp.handle(reqid, handle);
    } catch (err) {
      this._log(util.format('S3 error listing %s: %s', fullname, err));
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }
  }

  async _ensureUserDirectory(username) {
    try {
      // Get base path from config
      const basePath = config.sftp.userBasePath;
      
      // Note: No directory markers are created - directories are virtual
      this._log(util.format('User directory structure prepared for %s (no markers created)', username));

      // Create default subdirectories if enabled in config
      if (config.sftp.createDefaultSubdirs) {
        await this._createDefaultSubdirectories(username);
      }
      
    } catch (err) {
      this._log(util.format('Error preparing user directory for %s: %s', username, err));
    }
  }

  /**
   * Create default subdirectories for a user
   * @param {string} username - The username
   */
  async _createDefaultSubdirectories(username) {
    try {
      const basePath = config.sftp.userBasePath;
      const defaultDirs = config.sftp.defaultSubdirectories;
      
      for (const dirName of defaultDirs) {
        const subDirKey = `${basePath}/${username}/${dirName}/.directory`;
        const command = new PutObjectCommand({
          Bucket: this.bucketName,
          Key: subDirKey,
          Body: `Directory marker for ${dirName} folder`,
          ContentType: 'application/x-directory'
        });

        await this.s3Client.send(command);
        this._log(util.format('Created default subdirectory %s for user %s: %s', dirName, username, subDirKey));
      }
    } catch (err) {
      this._log(util.format('Error creating default subdirectories for user %s: %s', username, err));
    }
  }

  _processDirectoryListings(contents, fullname) {
    this._log(`Processing directory listings for: ${fullname}`);
    this._log(`Total contents: ${contents.length}`);
    
    return contents.filter(c => {
      let f = c.Key.substring(fullname.length);
      if (!f.startsWith('/')) {
        f = '/' + f;
      }
      if (f === '/.dir') {
        return false;
      }
      
      const parts = f.split('/');
      if (parts[0]) {
        return false;
      }
      
      this._log(`Processing: ${c.Key} -> ${f} (parts: ${parts.join(',')})`);
      
      // Handle directory markers (.directory files)
      if (parts.length === 3 && parts[2] === '.directory') {
        if (!parts[1]) {
          return false;
        }
        c.Key = c.Key.substring(0, c.Key.length - 11); // Remove '/.directory'
        c.IsDir = true;
        this._log(`Found directory marker: ${c.Key}`);
        return true;
      }
      
      // Handle regular files
      if (parts.length === 2) {
        this._log(`Found regular file: ${c.Key}`);
        return true;
      }
      
      // Handle subdirectories (show them as directories)
      if (parts.length > 2) {
        // Check if this is a directory by looking for children
        const dirKey = fullname + '/' + parts[1];
        const hasChildren = contents.some(other => 
          other.Key !== c.Key && 
          other.Key.startsWith(dirKey + '/')
        );
        
        if (hasChildren) {
          c.IsDir = true;
          c.Key = dirKey;
          this._log(`Found directory with children: ${c.Key}`);
          return true;
        }
      }

      // Also check if this path itself is a directory by looking for .directory markers
      const dirMarker = contents.find(other => other.Key === c.Key + '/.directory');
      if (dirMarker) {
        c.IsDir = true;
        this._log(`Found directory via .directory marker: ${c.Key}`);
        return true;
      }
      
      this._log(`Filtered out: ${c.Key}`);
      return false;
    });
  }

  _listDirectoryContents(sftp, reqid, state) {
    this._log(`Listing directory contents for: ${state.fullname}`);
    this._log(`Found ${state.listings.length} items in listing`);
    
    // Get user info for access control
    const user = state.user || { username: 'user' };
    
    let entries = state.listings.map(l => {
      let filename = l.Key.substring(state.fullname.length);
      if (filename.startsWith('/')) {
        filename = filename.substring(1);
      }
      if (filename.endsWith('/')) {
        filename = filename.substring(0, filename.length - 1);
      }

      const mode = l.IsDir ? 0o755 : 0o644;
      const size = l.IsDir ? 0 : l.Size;
      const lastModified = new Date(l.LastModified);

      this._log(`Entry: ${filename} (${l.IsDir ? 'dir' : 'file'}) size=${size}`);

      return {
        filename: filename,
        longname: `${l.IsDir ? 'd' : '-'}rw-rw-rw-    1 user user ${size} ${lastModified.toLocaleDateString()} ${lastModified.toLocaleTimeString()} ${filename}`,
        attrs: {
          mode: mode,
          uid: 0,
          gid: 0,
          size: size,
          atime: lastModified,
          mtime: lastModified
        }
      };
    });

    // Remove duplicates (in case we have both directory markers and children)
    const seen = new Set();
    entries = entries.filter(entry => {
      if (seen.has(entry.filename)) {
        return false;
      }
      seen.add(entry.filename);
      return true;
    });

    // If this is the root directory, show the user's own directory and available subdirectories
    if (state.fullname === '') {
      // Clear existing entries and show the user's own directory
      entries = [];
      
      const username = state.user ? state.user.username : 'user';
      
      // Add the user's main directory
      entries.push({
        filename: username,
        longname: `drwxr-xr-x    1 user user    0 Jan  1 00:00 ${username}`,
        attrs: {
          mode: 0o755,
          uid: 0,
          gid: 0,
          size: 0,
          atime: new Date(),
          mtime: new Date()
        }
      });
      
      // Add direct access to ledgers and invoices folders
      entries.push({
        filename: 'ledgers',
        longname: `drwxr-xr-x    1 user user    0 Jan  1 00:00 ledgers`,
        attrs: {
          mode: 0o755,
          uid: 0,
          gid: 0,
          size: 0,
          atime: new Date(),
          mtime: new Date()
        }
      });
      
      entries.push({
        filename: 'invoices',
        longname: `drwxr-xr-x    1 user user    0 Jan  1 00:00 invoices`,
        attrs: {
          mode: 0o755,
          uid: 0,
          gid: 0,
          size: 0,
          atime: new Date(),
          mtime: new Date()
        }
      });
      
      this._log(util.format('Root directory listing: showing user %s directory and direct access to ledgers/invoices', username));
    }

    // User will see their own files in their user-specific directory

    this._log('Returned directory details');
    sftp.name(reqid, entries);
  }

  // Utility operations
  _closeFile(sftp, reqid, state, handleId, openFiles, user) {
    if (state.flags & SFTP_OPEN_MODE.WRITE) {
      // For write operations, we need to wait for the upload to complete
      // before sending the status response
      state.stream.end();
      this._log('Stream closed, waiting for upload completion...');
      
      // Check if upload is already complete
      if (state.uploadComplete) {
        this._log('Upload already completed, sending status response');
        openFiles.delete(handleId);
        sftp.status(reqid, SFTP_STATUS_CODE.OK);
        return;
      }
      
      // Check if upload failed
      if (state.uploadError) {
        this._log('Upload failed, sending error status');
        openFiles.delete(handleId);
        sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
        return;
      }
      
      // Upload is still in progress, set up a polling mechanism
      const checkUploadStatus = () => {
        const currentState = openFiles.get(handleId);
        if (!currentState) {
          // Handle was already cleaned up
          return;
        }
        
        if (currentState.uploadComplete) {
          this._log('Upload completed, sending status response');
          openFiles.delete(handleId);
          sftp.status(reqid, SFTP_STATUS_CODE.OK);
        } else if (currentState.uploadError) {
          this._log('Upload failed, sending error status');
          openFiles.delete(handleId);
          sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
        } else {
          // Upload still in progress, check again in 100ms
          setTimeout(checkUploadStatus, 100);
        }
      };
      
      // Start checking upload status
      setTimeout(checkUploadStatus, 100);
      
      return;
    } else {
      this.emit('file-downloaded', { path: state.fullname, username: user.username });
      openFiles.delete(handleId);
    }

    this._log('Handle closed');
    sftp.status(reqid, SFTP_STATUS_CODE.OK);
  }

  async _deleteFileFromS3(sftp, reqid, fullname, user) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: fullname
      });

      await this.s3Client.send(command);
      
      this._log('File deleted');
      this.emit('file-deleted', { path: fullname, username: user.username });
      sftp.status(reqid, SFTP_STATUS_CODE.OK);
    } catch (err) {
      this._log(util.format('S3 error deleting object %s: %s', fullname, err));
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }
  }

  async _createDirectoryInS3(sftp, reqid, fullname, user) {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fullname,
        Body: ''
      });

      await this.s3Client.send(command);
      
      this._log('Directory created');
      this.emit('directory-created', { path: fullname, username: user.username });
      sftp.status(reqid, SFTP_STATUS_CODE.OK);
    } catch (err) {
      this._log(util.format('S3 error putting object %s: %s', fullname, err));
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }
  }

  async _deleteDirectoryFromS3(sftp, reqid, fullname, user) {
    try {
      // First, check if the directory marker exists
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: fullname
      });

      try {
        await this.s3Client.send(headCommand);
      } catch (err) {
        if (err.name === 'NotFound') {
          this._log(util.format('Directory marker %s not found', fullname));
          return sftp.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
        }
        throw err;
      }

      // Get the directory path without the .dir suffix
      const dirPath = fullname.replace('/.directory', '');
      
      // List all objects in the directory
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: dirPath + '/'
      });

      const response = await this.s3Client.send(listCommand);
      
      // Collect all objects to delete (including the directory marker)
      const objectsToDelete = [];
      
      // Add the directory marker
      objectsToDelete.push({ Key: fullname });
      
      // Add any files in the directory
      if (response.Contents) {
        response.Contents.forEach(obj => {
          if (obj.Key !== fullname) { // Don't add the directory marker twice
            objectsToDelete.push({ Key: obj.Key });
          }
        });
      }

      if (objectsToDelete.length === 0) {
        this._log(util.format('Directory %s is empty', dirPath));
        return sftp.status(reqid, SFTP_STATUS_CODE.OK);
      }

      const deleteCommand = new DeleteObjectsCommand({
        Bucket: this.bucketName,
        Delete: {
          Objects: objectsToDelete
        }
      });

      await this.s3Client.send(deleteCommand);
      
      this._log(util.format('Directory %s deleted with %d objects', dirPath, objectsToDelete.length));
      this.emit('directory-deleted', { path: dirPath, username: user.username });
      sftp.status(reqid, SFTP_STATUS_CODE.OK);
    } catch (err) {
      this._log(util.format('S3 error deleting directory %s: %s', fullname, err));
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }
  }

  async _renameInS3(sftp, reqid, fullnameOld, fullnameNew, user) {
    try {
      const copyCommand = new CopyObjectCommand({
        Bucket: this.bucketName,
        Key: fullnameNew,
        CopySource: `${this.bucketName}/${fullnameOld}`
      });

      await this.s3Client.send(copyCommand);

      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: fullnameOld
      });

      await this.s3Client.send(deleteCommand);
      
      this._log('File renamed');
      this.emit('file-renamed', { path: fullnameNew, oldPath: fullnameOld, username: user.username });
      sftp.status(reqid, SFTP_STATUS_CODE.OK);
    } catch (err) {
      this._log(util.format('S3 error renaming %s to %s: %s', fullnameOld, fullnameNew, err));
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }
  }

  async _getFileStats(sftp, reqid, filePath, user) {
    try {
      const fullname = this._mapKey(user.path, filePath);
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: fullname
      });

      const response = await this.s3Client.send(listCommand);
      
      const exactMatch = response.Contents.find(c => c.Key === fullname);
      if (exactMatch) {
        this._log('Retrieved file attrs');
        sftp.attrs(reqid, {
          mode: 0o644,
          uid: 0,
          gid: 0,
          size: exactMatch.Size,
          atime: exactMatch.LastModified,
          mtime: exactMatch.LastModified
        });
        return;
      }
      
      const directoryMatch = response.Contents.find(c => c.Key === fullname + '/.directory');
      if (directoryMatch) {
        this._log('Retrieved directory attrs');
        sftp.attrs(reqid, {
          mode: 0o755,
          uid: 0,
          gid: 0,
          size: 0,
          atime: directoryMatch.LastModified,
          mtime: directoryMatch.LastModified
        });
        return;
      }
      
      // Also check for legacy .dir markers
      const legacyDirMatch = response.Contents.find(c => c.Key === fullname + '/.dir');
      if (legacyDirMatch) {
        this._log('Retrieved directory attrs (legacy)');
        sftp.attrs(reqid, {
          mode: 0o755,
          uid: 0,
          gid: 0,
          size: 0,
          atime: legacyDirMatch.LastModified,
          mtime: legacyDirMatch.LastModified
        });
        return;
      }

      // Check if it's a directory by looking for children
      const hasChildren = response.Contents.some(c => c.Key !== fullname && c.Key.startsWith(fullname + '/'));
      if (hasChildren) {
        this._log('Retrieved directory attrs (has children)');
        sftp.attrs(reqid, {
          mode: 0o755,
          uid: 0,
          gid: 0,
          size: 0,
          atime: new Date(),
          mtime: new Date()
        });
        return;
      }
      
      this._log(util.format('Key %s not in listing', fullname));
      sftp.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    } catch (err) {
      this._log(util.format('S3 error getting stats for %s: %s', filePath, err));
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }
  }

  async _resolvePath(sftp, reqid, filePath, user) {
    try {
      if (filePath === '.') {
        filePath = '/';
      }
      
      let p = filePath;
      p = p.replace(/\\\\/g, '/');
      p = p.replace(/\\.\\/g, '/');
      p = p.replace(/\\/g, '/');
      p = path.normalize(p);
      p = p.replace(/\\/g, '/');
      
      if (!p.startsWith('/')) {
        p = '/' + p;
      }

      const fullname = this._mapKey(user.path, filePath);
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: fullname
      });

      const response = await this.s3Client.send(listCommand);
      const contents = response.Contents || [];
      this._log(util.format('%d objects found', contents.length));

      let realObj = contents.find(c => c.Key === fullname || c.Key === (fullname + '/.directory') || c.Key === (fullname + '/.dir'));

      if (realObj && (realObj.Key.endsWith('/.directory') || realObj.Key.endsWith('/.dir'))) {
        this._log(util.format('%s is a directory', realObj.Key));
        realObj.IsDir = true;
      }

      if (!realObj && (p === '/' || p === '/.' || p === '.')) {
        this._log(util.format('listing empty root directory %s', p));
        realObj = {
          IsDir: true,
          LastModified: new Date(),
          Size: 0
        };
        p = '/';
      }

      if (!realObj) {
        this._log(util.format('no objects found at %s', fullname));
        return sftp.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
      }

      const lastModified = new Date(realObj.LastModified);
      const name = [{
        filename: p,
        longname: `${realObj.IsDir ? 'd' : '-'}rw-rw-rw-    1 user user ${realObj.Size} ${lastModified.toLocaleDateString()} ${lastModified.toLocaleTimeString()} ${path.basename(p) || p}`
      }];

      this._log('Returning real name');
      sftp.name(reqid, name);
    } catch (err) {
      this._log(util.format('S3 error resolving path %s: %s', filePath, err));
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }
  }

  /**
   * Check if a user has access to a specific path
   * @param {string} username - The username
   * @param {string} path - The path to check
   * @returns {boolean} - True if access is allowed, false otherwise
   */
  _isPathAllowed(username, path) {
    const isAllowed = this.accessControl.isPathAllowed(username, path);
    
    if (!isAllowed) {
      this._log(util.format('Access denied for user %s to path: %s', username, path));
      this._log(util.format('Allowed paths for user %s: %s', username, this.accessControl.getAllowedPaths(username).join(', ')));
    }
    
    return isAllowed;
  }

  /**
   * Authenticate a user using S3-based authentication
   * @param {string} username - The username to authenticate
   * @param {string} password - The password to verify
   * @returns {Promise<boolean>} - True if authentication successful, false otherwise
   */
  async _authenticateUser(username, password) {
    try {
      if (!username || !password) {
        this._log('Username or password is missing');
        return false;
      }

      // Create the authentication key in S3
      const authKey = `auth/${username}_${password}`;
      
      this._log(util.format('Checking authentication for user %s with key: %s', username, authKey));

      // Check if the authentication file exists in S3
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: authKey
      });

      await this.s3Client.send(command);
      
      this._log(util.format('Authentication successful for user %s', username));
      return true;
    } catch (error) {
      if (error.name === 'NotFound') {
        this._log(util.format('Authentication failed for user %s: credentials not found', username));
        return false;
      }
      
      this._log(util.format('Authentication error for user %s: %s', username, error.message));
      return false;
    }
  }

  /**
   * Check if a path is a directory
   * @param {string} fullname - The full S3 key path
   * @returns {Promise<boolean>} - True if directory, false if file
   */
  async _checkIfDirectory(fullname) {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: fullname
      });

      const response = await this.s3Client.send(command);
      
      this._log(util.format('Checking if directory: %s', fullname));
      response.Contents.forEach(obj => {
        this._log(`  Found: ${obj.Key}`);
      });
      
      // Check for directory marker
      const directoryMatch = response.Contents.find(c => c.Key === fullname + '/.directory');
      if (directoryMatch) {
        this._log(util.format('Found directory marker for: %s', fullname));
        return true;
      }

      // Also check for legacy .dir markers
      const legacyDirMatch = response.Contents.find(c => c.Key === fullname + '/.dir');
      if (legacyDirMatch) {
        this._log(util.format('Found legacy directory marker for: %s', fullname));
        return true;
      }

      // Check if there are any objects with this prefix (indicating it's a directory)
      const hasChildren = response.Contents.some(c => c.Key !== fullname && c.Key.startsWith(fullname + '/'));
      if (hasChildren) {
        this._log(util.format('Found children for directory: %s', fullname));
        return true;
      }

      // Check for exact file match
      const exactMatch = response.Contents.find(c => c.Key === fullname);
      if (exactMatch) {
        this._log(util.format('Found exact file match: %s', fullname));
        return false; // It's a file
      }

      // If no exact match and no children, it might be a directory
      this._log(util.format('No exact match found for: %s', fullname));
      return false;
    } catch (err) {
      this._log(util.format('Error checking if directory %s: %s', fullname, err));
      return false;
    }
  }
}

module.exports = SFTPS3Server; 