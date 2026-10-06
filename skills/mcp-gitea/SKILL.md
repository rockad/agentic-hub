---
name: mcp-gitea
description: >
  Gitea repository operations: list/search repos, read issues and commits,
  get file contents and repository trees, create or update files. Use when
  the user wants to inspect or modify a Gitea-hosted codebase.
when_to_use: The user asks to list their repos, search for a repo, read an
  issue, view a commit, fetch a file, or write a file to a Gitea repo.
allowed-tools: mcp(gitea/*)
metadata:
  author: agentic-hub
  source: antigravity-mcp
  registration: opencode-global-mcp
  mcp: gitea
---

# gitea (MCP bridge)

Gitea repository interface, exposed to OpenCode.

## Server
- Registered natively in OpenCode global config (`mcp.servers`) via the antigravity bridge
- Tools: `list_my_repos`, `search_repos`, `list_issues`, `issue_read`,
  `list_commits`, `get_commit`, `get_file_contents`, `get_repository_tree`,
  `create_or_update_file`, `actions_run_read`

## How to use

### List my repositories
```
mcp(gitea/list_my_repos) { "limit": 20 }
```

### Search repositories
```
mcp(gitea/search_repos) { "query": "my-repo", "limit": 10 }
```

### Read an issue
```
mcp(gitea/issue_read) { "owner": "my-org", "repo": "my-repo", "index": 42 }
```

### Get a file's contents
```
mcp(gitea/get_file_contents) { "owner": "my-org", "repo": "my-repo", "path": "README.md", "ref": "main" }
```

### Create or update a file
```
mcp(gitea/create_or_update_file) {
  "owner": "my-org",
  "repo": "my-repo",
  "path": "docs/new.md",
  "content": "# New doc",
  "message": "Add new doc",
  "branch": "main"
}
```

## Tips
- `get_repository_tree` returns a recursive tree; filter locally.
- `actions_run_read` fetches CI run logs if Gitea Actions is configured.
- All mutating operations require a commit message and optional branch.