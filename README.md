# SFTP S3 Server

A robust SFTP server that connects to AWS S3 for file storage using the latest AWS SDK v3. This server provides a complete SFTP interface to your S3 buckets with proper authentication, logging, and event handling.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Generate SSH keys
npm run generate-keys

# Start the server
npm start
```

## 📁 Project Structure

```
sftp-s3-server/
├── src/                    # Source code
│   ├── main.js            # Main server entry point
│   └── server.js          # SFTP server class
├── config/                 # Configuration
│   ├── config.js          # Server configuration
│   └── access-control.js  # User access control configuration
├── scripts/               # Utility scripts
│   ├── generate-keys.sh   # SSH key generation
│   ├── manage-users.js    # User management for authentication
│   └── *.sh              # Test and utility scripts
├── tests/                 # Test files
│   ├── test-server.js     # Test server
│   └── test-authentication.js # Authentication system tests
├── keys/                  # SSH keys (generated)
│   ├── server_key_rsa
│   ├── server_key_rsa.pub
│   ├── client_key_rsa
│   └── client_key_rsa.pub
├── docs/                  # Documentation
│   ├── README.md         # Detailed documentation
│   ├── RUNNING.md        # Quick start guide
│   └── AUTHENTICATION.md # Authentication system guide
├── package.json          # Project configuration
└── .gitignore           # Git ignore rules
```

## ⚙️ Configuration

### **Environment Variables**

The server can be configured using environment variables. Copy `config/env.example` to `.env` and modify as needed:

```bash
# SFTP Server Configuration
SFTP_PORT=2222
SFTP_HOST=127.0.0.1
SFTP_MAX_CONNECTIONS=100

# SFTP Path Configuration
SFTP_USER_BASE_PATH=users          # Base path for user directories
SFTP_DEFAULT_SUBDIRS=invoices,ledgers  # Default subdirectories to create
SFTP_CREATE_DEFAULT_SUBDIRS=true   # Whether to create default subdirectories

# AWS S3 Configuration
S3_BUCKET=your-sftp-bucket-name
AWS_REGION=ap-south-1
S3_MAX_FILE_SIZE=104857600

# Authentication
SFTP_DEFAULT_USER=user

# Logging
LOGGING_ENABLED=true
LOG_LEVEL=info
```

### **Changing Base Path**

To change the base path from `users` to something else (e.g., `clients`):

```bash
export SFTP_USER_BASE_PATH=clients
```

This will create the structure: `clients/{username}/` instead of `users/{username}/`

### **Customizing Default Subdirectories**

To create different default subdirectories:

```bash
export SFTP_DEFAULT_SUBDIRS=documents,reports,archives
```

### **Disabling Default Subdirectories**

To disable automatic creation of default subdirectories:

```bash
export SFTP_CREATE_DEFAULT_SUBDIRS=false
```

## 🔐 User-Specific Folders

The server now supports user-specific folders for enhanced security and organization:

### **Automatic Folder Creation**
- On successful login, the server automatically creates a `users/{username}` folder in S3
- Each user gets their own isolated directory structure
- Base path for each user is set to their specific folder

### **Default Subdirectories**
- Automatically creates `invoices` and `ledgers` folders for each user
- Configurable via environment variables
- Can be disabled if not needed

### **Path Configuration**
- Base path is configurable (default: `users`)
- Default subdirectories are configurable
- Easy to change the entire folder structure

### **Access Control**
- Users can only access their own `users/{username}` directory and subdirectories
- Root directory shows only the user's own folder
- Access control prevents users from accessing other users' directories

### **Folder Structure Example**
```
S3 Bucket Structure:
├── users/
│   ├── user1/
│   │   ├── .directory          # Directory marker
│   │   ├── documents/
│   │   └── uploads/
│   ├── user2/
│   │   ├── .directory          # Directory marker
│   │   └── files/
│   └── admin/
│       ├── .directory          # Directory marker
│       └── reports/
```

### **Testing User Folders**
```bash
# Test user folder creation and access control
node test-user-folders.js

# Clean up test data
node test-user-folders.js --cleanup
```

## 🛠️ Available Commands

- `npm start` - Start the production server
- `npm run dev` - Start development server with debugging
- `npm test` - Run test server
- `npm run test-refresh` - Run auto-refresh test server
- `npm run generate-keys` - Generate SSH keys

### User Management Commands

- `node scripts/manage-users.js add <username> <password> [description]` - Add new user
- `node scripts/manage-users.js list` - List all users
- `node scripts/manage-users.js change-password <username> <old> <new>` - Change password
- `node scripts/manage-users.js remove <username> <password>` - Remove user

### Default Directory Management

- `node scripts/manage-default-dirs.js` - Create default directories for all existing users
- `node scripts/manage-default-dirs.js <username>` - Create default directories for specific user
- `node scripts/manage-default-dirs.js user1 user2 user3` - Create for multiple specific users

### Testing Commands

- `node tests/test-authentication.js` - Test authentication system
- `node test-directory-blocking.js` - Test that directory creation/deletion is blocked

## 📖 Documentation

- [Detailed Documentation](docs/README.md) - Complete setup and usage guide
- [Quick Start Guide](docs/RUNNING.md) - Get up and running quickly

## 🔧 Configuration

The server is highly configurable through environment variables. See [config/config.js](config/config.js) for all available options.

### Access Control Configuration

User access permissions are defined in [config/access-control.js](config/access-control.js):

```javascript
// Example: Allow user 'admin' to access their own directory
allowedPaths: {
  'admin': [
    '/',           // Root directory
    '/admin'       // Admin's own directory
  ]
}
```

## 🔐 Security

- SSH key-based authentication
- User-specific folder isolation
- File extension filtering
- Directory depth limits
- Configurable security policies
- Access control per user
- **Directory creation/deletion blocked** - Users cannot create or delete directories

## 🚫 Directory Restrictions

The SFTP server has strict directory management policies to maintain data integrity:

### **Directory Creation Blocked**
- Users **cannot create new directories** using `mkdir` command
- All `MKDIR` operations return "Permission Denied" error
- System directories are created automatically during user authentication

### **Directory Deletion Blocked**
- Users **cannot delete directories** using `rmdir` command
- All `RMDIR` operations return "Permission Denied" error
- Prevents accidental deletion of important directory structures

### **Protected Directories**
- **Ledgers and Invoices directories are PROTECTED** from deletion
- Users cannot delete, rename, or remove these critical directories
- Protection covers both root-level and user-specific ledgers/invoices folders
- Directory marker files (`.directory`) are also protected

### **Automatic Directory Management**
- User base directories are created automatically on login
- Default subdirectories (invoices, ledgers) are created automatically
- Directory structure is managed by the system, not by users

### **Why This Restriction?**
- Maintains consistent folder structure across all users
- Prevents users from creating unnecessary or duplicate directories
- Ensures data organization follows company policies
- Reduces S3 storage costs from orphaned directories
- **Protects critical business directories** (ledgers, invoices) from accidental deletion
- **Prevents data loss** by blocking removal of important directory structures

## 🔄 Auto-Refresh Feature

The server includes intelligent auto-refresh functionality to ensure uploaded files appear immediately in directory listings:

- **No Caching**: Always fresh S3 listings for immediate file visibility
- **S3 Consistency Handling**: Built-in delays to handle S3 eventual consistency
- **Upload Detection**: Automatic tracking of recent uploads
- **Fresh Listings**: Force fresh S3 listings for recently uploaded files

### Testing Auto-Refresh

To test the auto-refresh functionality:

```bash
npm run test-refresh
```

This starts a test server with enhanced logging that shows when files are uploaded and directory caches are cleared.

## 📝 License

ISC 