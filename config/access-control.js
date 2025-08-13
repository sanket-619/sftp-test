"use strict";

const config = require("./config");

const accessControl = {
    // Define allowed paths for each user
    allowedPaths: {
        // User 'user' can access their base path and subdirectories
        'user': [
            '/', // Root directory (to see their own folder)
            '/user', // Their own user directory
            '/ledgers', // Direct access to ledgers folder
            '/invoices' // Direct access to invoices folder
        ],
        // You can add more users here
        // 'admin': [
        //   '/',               // Root directory
        //   '/admin'           // Admin's own directory
        // ],
        // 'guest': [
        //   '/',               // Root directory
        //   '/guest'           // Guest's own directory
        // ]
    },
    /**
     * Default paths for new users (if not explicitly defined above)
     */
    defaultPaths: [
        '/', // Root directory (to see their own folder)
        '/ledgers', // Direct access to ledgers folder
        '/invoices' // Direct access to invoices folder
    ],
    /**
     * Check if a user has access to a specific path
     * @param username - The username
     * @param path - The path to check
     * @returns True if access is allowed
     */
    isPathAllowed: function (username, path) {
        const userPaths = this.allowedPaths[username] || this.defaultPaths;
        // Normalize the path
        let normalizedPath = path;
        if (!normalizedPath.startsWith('/')) {
            normalizedPath = '/' + normalizedPath;
        }
        console.log(`[DEBUG] Checking access for user '${username}' to path '${path}' (normalized: '${normalizedPath}')`);
        console.log(`[DEBUG] User allowed paths: ${userPaths.join(', ')}`);
        // Check if the path is exactly allowed
        if (userPaths.includes(normalizedPath)) {
            console.log(`[DEBUG] Path exactly matches allowed path`);
            return true;
        }
        // Check if the path is a subdirectory of an allowed path
        for (const allowedPath of userPaths) {
            if (normalizedPath.startsWith(allowedPath + '/') || normalizedPath === allowedPath) {
                console.log(`[DEBUG] Path is subdirectory of allowed path: ${allowedPath}`);
                return true;
            }
        }
        // Special case: allow users to access their own user folder
        const userBasePath = config.sftp.userBasePath;
        if (normalizedPath === `/${username}` || normalizedPath.startsWith(`/${username}/`)) {
            console.log(`[DEBUG] Path is user's own directory: ${username}`);
            return true;
        }
        // Special case: allow direct access to ledgers and invoices folders
        // These will be mapped to the user's specific directory
        if (normalizedPath === '/ledgers' || normalizedPath === '/invoices' ||
            normalizedPath.startsWith('/ledgers/') || normalizedPath.startsWith('/invoices/')) {
            console.log(`[DEBUG] Path is direct access to ledgers/invoices: ${normalizedPath}`);
            return true;
        }
        // Special case: allow users to upload files to root (will be mapped to their user directory)
        // This allows users to upload files like /filename.jpg which gets mapped to /users/username/filename.jpg
        if (normalizedPath !== '/' && normalizedPath.startsWith('/') && normalizedPath.split('/').length === 2) {
            console.log(`[DEBUG] Path is root-level file (parts: ${normalizedPath.split('/').length})`);
            return true;
        }
        console.log(`[DEBUG] Access denied - no matching rule found`);
        return false;
    },
    /**
     * Get all allowed paths for a user
     * @param username - The username
     * @returns Array of allowed paths
     */
    getAllowedPaths: function (username) {
        const basePaths = this.allowedPaths[username] || this.defaultPaths;
        // Add user's own directory to allowed paths
        return [...basePaths, `/${username}`];
    }
};

module.exports = accessControl;