---
name: rclone-cloud-storage
description: Manage Google Drive, OneDrive, and multi-cloud storage operations using rclone CLI and helper tooling.
when_to_use: Transfer files, sync directories, check storage quota, list remote paths, or manage backups across Google Drive, OneDrive, or any rclone cloud remote.
argument-hint: "<command> <source|remote> [destination] [--dry-run]"
allowed-tools: Bash(bash *) Bash(rclone *) Bash(python3 *) Read
metadata:
  author: aleksandr
  requires: rclone
---

# rclone-cloud-storage

Seamlessly interact with cloud storage providers — specifically **Google Drive** (`<remote-name>:`) and **OneDrive** (`onedrive:`) — using `rclone` CLI and automated Python scripts.

## Features

- **Multi-Cloud Management**: Direct integration with Google Drive, Microsoft OneDrive, Nextcloud, S3, and standard webdav/ftp remotes.
- **Quota & Usage Monitoring**: Real-time storage consumption tracking across configured remotes.
- **Fast Uploads & Downloads**: Copy files/directories locally or across cloud remotes with automatic retry and progress reporting.
- **One-Way Mirror (Destination made identical to Source; deletes extra files at destination)**: Synchronize folders while preserving metadata, directory structure, and modification timestamps.
- **Two-Way Sync (`rclone bisync`)**: Perform bidirectional synchronization between two remotes or a local path and remote, preserving metadata.
- **Safe Execution**: Built-in support for `--dry-run` to preview file transfers before executing changes.

## Prerequisites & Configuration

Ensure `rclone` is installed and remotes are configured:

```bash
# Check configured remotes:
rclone listremotes
# Or using helper script:
python3 $SKILL_DIR/scripts/rclone_cloud.py remotes
```

### Configured Remotes
- **Google Drive**: `<remote-name>:`
- **OneDrive**: `onedrive:` (or configured name from `rclone listremotes`)

---

## Direct CLI Cheatsheet

### 1. Quota & Storage Info
```bash
# Display total, used, and free quota on Google Drive:
rclone about <remote-name>:

# Display OneDrive storage quota:
rclone about onedrive:
```

### 2. Listing Remote Contents
```bash
# List files/folders in root:
rclone lsf <remote-name>:

# List specific folder recursively:
rclone lsf -R <remote-name>:Inbox/

# Tree view of a directory:
rclone tree onedrive:Documents/
```

### 3. Upload & Download Files
```bash
# Upload a single file to Google Drive Inbox:
rclone copy /path/to/local_file.pdf <remote-name>:Inbox/

# Upload an entire directory:
rclone copy /path/to/local_folder/ <remote-name>:Documents/Reports/

# Download a file from OneDrive:
rclone copy onedrive:Documents/presentation.pptx ~/Downloads/
```

### 4. Directory Syncing & Mirroring (One-Way Mirror)
```bash
# Dry-run preview before syncing:
rclone sync ~/projects/notes/ <remote-name>:NotesBackup/ --dry-run

# Mirror local folder to Google Drive (destination made identical to source):
rclone sync ~/projects/notes/ <remote-name>:NotesBackup/ -P
```

### 5. Two-Way Sync (Bi-directional using `rclone bisync`)
```bash
# Dry-run preview before bidirectional sync:
rclone bisync /local/dir <remote-name>:RemoteDir/ --dry-run

# Perform two-way sync:
rclone bisync /local/dir <remote-name>:RemoteDir/ -P
```

### 6. File Deletion & Purging
```bash
# Delete a single remote file:
rclone deletefile <remote-name>:Inbox/unwanted_draft.md

# Purge a folder and all its contents:
rclone purge <remote-name>:OldBackup/
```

---

## Python Helper Script Usage

The skill provides a Python CLI wrapper (`scripts/rclone_cloud.py`) for simplified agent and user interaction:

```bash
# List all active cloud remotes:
python3 $SKILL_DIR/scripts/rclone_cloud.py remotes

# Check quota for Google Drive:
python3 $SKILL_DIR/scripts/rclone_cloud.py about <remote-name>:

# List files in Google Drive Inbox:
python3 $SKILL_DIR/scripts/rclone_cloud.py ls <remote-name>:Inbox/

# Upload file/folder:
python3 $SKILL_DIR/scripts/rclone_cloud.py upload /path/to/file.pdf <remote-name>:Inbox/

# Download file/folder:
python3 $SKILL_DIR/scripts/rclone_cloud.py download <remote-name>:Inbox/file.pdf ./

# One-way mirror directories (destination made identical to source, with optional dry run):
python3 $SKILL_DIR/scripts/rclone_cloud.py sync /local/dir <remote-name>:RemoteDir/ --dry-run

# Two-way sync directories (rclone bisync, with optional dry run):
python3 $SKILL_DIR/scripts/rclone_cloud.py bisync /local/dir <remote-name>:RemoteDir/ --dry-run
```
