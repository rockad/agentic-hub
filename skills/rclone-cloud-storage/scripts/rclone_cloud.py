#!/usr/bin/env python3
"""
rclone_cloud.py - CLI Helper for Google Drive, OneDrive, and Cloud Storage Management via rclone.
"""

import sys
import os
import subprocess
import argparse
import json
from typing import List, Optional

RCLONE_BIN = os.environ.get("RCLONE_BIN", "rclone")

def run_rclone(args: List[str], check: bool = True) -> subprocess.CompletedProcess:
    """Execute an rclone command and return the completed process."""
    cmd = [RCLONE_BIN] + args
    try:
        if "-P" in args:
            sys.stdout.flush()
            sys.stderr.flush()
            res = subprocess.run(cmd, check=check)
        else:
            res = subprocess.run(cmd, capture_output=True, text=True, check=check)
        return res
    except FileNotFoundError:
        print(f"Error: '{RCLONE_BIN}' executable not found in PATH.", file=sys.stderr)
        print("Please install rclone: https://rclone.org/install/", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"rclone command failed with exit code {e.returncode}:", file=sys.stderr)
        print(f"Command: {' '.join(cmd)}", file=sys.stderr)
        if e.stderr:
            print(f"Error Output:\n{e.stderr}", file=sys.stderr)
        sys.exit(e.returncode)

def list_remotes() -> List[str]:
    """List all configured rclone remotes."""
    res = run_rclone(["listremotes"])
    remotes = [line.strip() for line in res.stdout.splitlines() if line.strip()]
    return remotes

def cmd_remotes(args: argparse.Namespace) -> None:
    """Handle 'remotes' subcommand."""
    remotes = list_remotes()
    if not remotes:
        print("No rclone remotes configured.")
        return
    print(f"Configured rclone remotes ({len(remotes)}):")
    for r in remotes:
        print(f"  - {r}")

def cmd_about(args: argparse.Namespace) -> None:
    """Handle 'about' / 'quota' subcommand."""
    res = run_rclone(["about", args.remote, "--json"])
    try:
        data = json.loads(res.stdout)
        total = data.get("total", 0)
        used = data.get("used", 0)
        free = data.get("free", 0)
        
        def fmt_size(b: int) -> str:
            for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
                if abs(b) < 1024.0:
                    return f"{b:3.1f} {unit}"
                b /= 1024.0
            return f"{b:.1f} PB"

        print(f"Storage Quota for '{args.remote}':")
        if total:
            pct = (used / total) * 100
            print(f"  - Total: {fmt_size(total)}")
            print(f"  - Used:  {fmt_size(used)} ({pct:.1f}%)")
            print(f"  - Free:  {fmt_size(free)}")
        else:
            print(f"  - Used:  {fmt_size(used)}")
    except Exception as e:
        print(res.stdout)

def cmd_ls(args: argparse.Namespace) -> None:
    """Handle 'ls' subcommand."""
    cmd_args = ["lsf"]
    if args.dirs_only:
        cmd_args.append("--dirs-only")
    elif args.files_only:
        cmd_args.append("--files-only")
    if args.recursive:
        cmd_args.append("-R")
    
    cmd_args.append(args.path)
    res = run_rclone(cmd_args)
    if res.stdout:
        print(res.stdout.strip())

def cmd_upload(args: argparse.Namespace) -> None:
    """Handle 'upload' subcommand."""
    source = args.source
    dest = args.destination
    cmd_args = ["copy", source, dest, "-P"]
    if args.dry_run:
        cmd_args.append("--dry-run")
    print(f"Uploading '{source}' -> '{dest}'...")
    res = run_rclone(cmd_args)
    if res.stdout:
        print(res.stdout.strip())
    if args.dry_run:
        print("[DRY-RUN] Simulation completed. No files were modified.")
    else:
        print("Upload completed successfully.")

def cmd_download(args: argparse.Namespace) -> None:
    """Handle 'download' subcommand."""
    source = args.source
    dest = args.destination
    cmd_args = ["copy", source, dest, "-P"]
    if args.dry_run:
        cmd_args.append("--dry-run")
    print(f"Downloading '{source}' -> '{dest}'...")
    res = run_rclone(cmd_args)
    if res.stdout:
        print(res.stdout.strip())
    if args.dry_run:
        print("[DRY-RUN] Simulation completed. No files were modified.")
    else:
        print("Download completed successfully.")

def cmd_sync(args: argparse.Namespace) -> None:
    """Handle 'sync' subcommand."""
    source = args.source
    dest = args.destination
    cmd_args = ["sync", source, dest, "-P"]
    if args.dry_run:
        cmd_args.append("--dry-run")
    print(f"Syncing '{source}' -> '{dest}'...")
    res = run_rclone(cmd_args)
    if res.stdout:
        print(res.stdout.strip())
    if args.dry_run:
        print("[DRY-RUN] Simulation completed. No files were modified.")
    else:
        print("Sync completed successfully.")

def cmd_bisync(args: argparse.Namespace) -> None:
    """Handle 'bisync' subcommand."""
    source = args.source
    dest = args.destination
    cmd_args = ["bisync", source, dest, "-P"]
    if args.resync:
        cmd_args.append("--resync")
    if args.dry_run:
        cmd_args.append("--dry-run")
    print(f"Bisyncing '{source}' <-> '{dest}'...")
    res = run_rclone(cmd_args)
    if res.stdout:
        print(res.stdout.strip())
    if args.dry_run:
        print("[DRY-RUN] Simulation completed. No files were modified.")
    else:
        print("Bisync completed successfully.")

def cmd_delete(args: argparse.Namespace) -> None:
    """Handle 'delete' subcommand."""
    path = args.path
    if args.purge:
        cmd_args = ["purge", path]
    else:
        cmd_args = ["deletefile", path]
    if args.dry_run:
        cmd_args.append("--dry-run")
    print(f"Deleting '{path}'...")
    res = run_rclone(cmd_args)
    if res.stdout:
        print(res.stdout.strip())
    if args.dry_run:
        print("[DRY-RUN] Simulation completed. No files were modified.")
    else:
        print("Delete operation completed.")

def main():
    parser = argparse.ArgumentParser(description="rclone-cloud-storage CLI Helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Subcommand: remotes
    p_remotes = subparsers.add_parser("remotes", help="List all configured rclone remotes")
    p_remotes.set_defaults(func=cmd_remotes)

    # Subcommand: quota / about
    p_about = subparsers.add_parser("about", help="Check storage quota for a remote")
    p_about.add_argument("remote", help="Remote name (e.g. gdrive-aleks: or onedrive:)")
    p_about.set_defaults(func=cmd_about)

    # Subcommand: ls
    p_ls = subparsers.add_parser("ls", help="List files or directories in remote path")
    p_ls.add_argument("path", help="Remote path (e.g. gdrive-aleks:Inbox/)")
    p_ls.add_argument("-r", "--recursive", action="store_true", help="List recursively")
    p_ls.add_argument("--dirs-only", action="store_true", help="List directories only")
    p_ls.add_argument("--files-only", action="store_true", help="List files only")
    p_ls.set_defaults(func=cmd_ls)

    # Subcommand: upload
    p_up = subparsers.add_parser("upload", help="Upload local file/dir to remote destination")
    p_up.add_argument("source", help="Local source path")
    p_up.add_argument("destination", help="Remote destination path")
    p_up.add_argument("--dry-run", action="store_true", help="Perform a dry run without modifying remote")
    p_up.set_defaults(func=cmd_upload)

    # Subcommand: download
    p_dl = subparsers.add_parser("download", help="Download remote file/dir to local destination")
    p_dl.add_argument("source", help="Remote source path")
    p_dl.add_argument("destination", help="Local destination path")
    p_dl.add_argument("--dry-run", action="store_true", help="Perform a dry run")
    p_dl.set_defaults(func=cmd_download)

    # Subcommand: sync
    p_sync = subparsers.add_parser("sync", help="Mirror source directory to destination (one-way)")
    p_sync.add_argument("source", help="Source path (local or remote)")
    p_sync.add_argument("destination", help="Destination path (local or remote)")
    p_sync.add_argument("--dry-run", action="store_true", help="Perform a dry run")
    p_sync.set_defaults(func=cmd_sync)

    # Subcommand: bisync
    p_bisync = subparsers.add_parser("bisync", help="Perform bidirectional sync between source and destination")
    p_bisync.add_argument("source", help="Source path (local or remote)")
    p_bisync.add_argument("destination", help="Destination path (local or remote)")
    p_bisync.add_argument("--resync", action="store_true", help="Force resync on bisync initialization")
    p_bisync.add_argument("--dry-run", action="store_true", help="Perform a dry run")
    p_bisync.set_defaults(func=cmd_bisync)

    # Subcommand: delete
    p_del = subparsers.add_parser("delete", help="Delete a file or purge directory from remote")
    p_del.add_argument("path", help="Remote path to delete")
    p_del.add_argument("--purge", action="store_true", help="Purge an entire folder and its contents")
    p_del.add_argument("--dry-run", action="store_true", help="Perform a dry run")
    p_del.set_defaults(func=cmd_delete)

    args = parser.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
