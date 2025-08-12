'use strict';

const express = require('express');
const { S3Client } = require('@aws-sdk/client-s3');
const FolderAccess = require('./folder-access');
const config = require('../config/config');

/**
 * Folder API Server
 * Provides HTTP endpoints for SFTP clients to get accessible folders
 */
class FolderAPI {
  constructor() {
    this.app = express();
    this.s3Client = new S3Client({
      region: config.s3.region
    });
    this.folderAccess = new FolderAccess(this.s3Client, config.s3.bucket);
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // CORS for cross-origin requests
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      next();
    });

    // Basic logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Get accessible folders for a user
    this.app.get('/api/folders/:username', async (req, res) => {
      try {
        const { username } = req.params;
        const { includeMetadata } = req.query;

        if (!username) {
          return res.status(400).json({ error: 'Username is required' });
        }

        let folders;
        if (includeMetadata === 'true') {
          folders = await this.folderAccess.getUserFoldersWithMetadata(username);
        } else {
          folders = await this.folderAccess.getUserAccessibleFolders(username);
        }

        res.json({
          username,
          timestamp: new Date().toISOString(),
          folderCount: folders.length,
          folders
        });

      } catch (error) {
        console.error(`Error getting folders for user ${req.params.username}:`, error);
        res.status(500).json({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });

    // Get simple folder paths for a user
    this.app.get('/api/folders/:username/paths', async (req, res) => {
      try {
        const { username } = req.params;

        if (!username) {
          return res.status(400).json({ error: 'Username is required' });
        }

        const folderPaths = await this.folderAccess.getUserFolderPaths(username);

        res.json({
          username,
          timestamp: new Date().toISOString(),
          folderCount: folderPaths.length,
          folders: folderPaths
        });

      } catch (error) {
        console.error(`Error getting folder paths for user ${req.params.username}:`, error);
        res.status(500).json({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });

    // Get folder metadata for a specific folder
    this.app.get('/api/folders/:username/metadata/:folderPath(*)', async (req, res) => {
      try {
        const { username, folderPath } = req.params;

        if (!username || !folderPath) {
          return res.status(400).json({ error: 'Username and folder path are required' });
        }

        // Decode the folder path from URL
        const decodedPath = decodeURIComponent(folderPath);
        
        // Get metadata for the specific folder
        const metadata = await this.folderAccess._getFolderMetadata(decodedPath, username);

        res.json({
          username,
          folderPath: decodedPath,
          timestamp: new Date().toISOString(),
          metadata
        });

      } catch (error) {
        console.error(`Error getting metadata for folder ${req.params.folderPath}:`, error);
        res.status(500).json({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });

    // Search folders by name
    this.app.get('/api/folders/:username/search', async (req, res) => {
      try {
        const { username } = req.params;
        const { query, limit = 10 } = req.query;

        if (!username) {
          return res.status(400).json({ error: 'Username is required' });
        }

        if (!query) {
          return res.status(400).json({ error: 'Search query is required' });
        }

        const folders = await this.folderAccess.getUserAccessibleFolders(username);
        
        // Filter folders by name (case-insensitive)
        const filteredFolders = folders
          .filter(folder => 
            folder.name.toLowerCase().includes(query.toLowerCase()) ||
            folder.path.toLowerCase().includes(query.toLowerCase())
          )
          .slice(0, parseInt(limit));

        res.json({
          username,
          query,
          timestamp: new Date().toISOString(),
          totalFound: filteredFolders.length,
          folders: filteredFolders
        });

      } catch (error) {
        console.error(`Error searching folders for user ${req.params.username}:`, error);
        res.status(500).json({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });

    // Error handling middleware
    this.app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      res.status(500).json({ 
        error: 'Internal server error',
        message: 'An unexpected error occurred' 
      });
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ 
        error: 'Not found',
        message: `Endpoint ${req.method} ${req.path} not found` 
      });
    });
  }

  /**
   * Start the API server
   * @param {number} port - Port to listen on
   * @param {string} host - Host to bind to
   * @param {Function} callback - Callback when server starts
   */
  start(port = 3001, host = 'localhost', callback) {
    this.server = this.app.listen(port, host, () => {
      console.log(`🚀 Folder API server listening on ${host}:${port}`);
      console.log(`📁 Available endpoints:`);
      console.log(`   GET /health - Health check`);
      console.log(`   GET /api/folders/:username - Get accessible folders`);
      console.log(`   GET /api/folders/:username/paths - Get folder paths only`);
      console.log(`   GET /api/folders/:username/metadata/:folderPath - Get folder metadata`);
      console.log(`   GET /api/folders/:username/search?query=... - Search folders`);
      
      if (callback) {
        callback(port);
      }
    });

    return this.server;
  }

  /**
   * Stop the API server
   * @param {Function} callback - Callback when server stops
   */
  stop(callback) {
    if (this.server) {
      this.server.close(callback);
      this.server = null;
    } else {
      process.nextTick(callback);
    }
  }
}

module.exports = FolderAPI;
