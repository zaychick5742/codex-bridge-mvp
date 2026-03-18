# Publishing To GitHub

This repository is prepared as a standalone public copy.

## Remaining Manual Steps

1. Configure Git identity:

```bash
git config --global user.name "Your GitHub Name"
git config --global user.email "your-github-email@example.com"
git config --global init.defaultBranch main
```

2. Create a new GitHub repository from the web UI.

Recommended settings:

- Repository name: `codex-bridge-mvp`
- Visibility: `Public`
- Do not auto-add a README, `.gitignore`, or license

3. In this repository root, create the first commit and push:

```bash
git add .
git commit -m "Initial open-source release"
git remote add origin https://github.com/<your-github-username>/codex-bridge-mvp.git
git push -u origin main
```

## Notes

- This copy has already been cleaned of machine-specific absolute paths from public-facing handoff documents.
- Build outputs and local runtime state are ignored by `.gitignore`.
- Run `npm install` and `npm run smoke` before the first push if you want to re-verify locally.
