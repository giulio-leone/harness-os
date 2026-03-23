# Contributing to Agent Harness Core

First off, thank you for considering contributing to the Agent Harness Core! 

This document outlines the process for suggesting improvements, fixing bugs, and contributing code to the repository.

## Table of Contents
1. [Reporting Bugs](#reporting-bugs)
2. [Suggesting Enhancements](#suggesting-enhancements)
3. [Your First Code Contribution](#your-first-code-contribution)
4. [Pull Request Process](#pull-request-process)

## Reporting Bugs
Bugs are tracked as GitHub Issues. Before creating bug reports, please check the existing issues to ensure the bug hasn't already been reported.

When creating a new issue:
- Explain the problem and provide a detailed, reproducible example.
- Provide the environment (OS, Node version, `mem0` availability).
- Include terminal logs of the error that occurred.

## Suggesting Enhancements
Enhancement suggestions are tracked as GitHub Issues. Provide a clear and detailed explanation of the feature and how it aligns with the core principles of the harness.

## Your First Code Contribution
1. **Fork the repo** and clone it locally.
2. Checkout a new branch from `main`: `git checkout -b my-new-feature`
3. Run `npm install` and `npm run build` to ensure the project works on your machine.
4. Add your changes. If it is a new feature or logic fix, add tests inside `tests/`.
5. Run tests locally using `npm test`.
6. Ensure your code satisfies `npm run typecheck`.

## Pull Request Process
- Ensure any install or build dependencies are removed before the end of the layer when doing a build.
- Update the `README.md` with details of changes to the interface, new variables, or modifications.
- Reference the Issue that your Pull Request will resolve.
- Check the License constraints carefully. By contributing, you agree that your contributions will be licensed under its Business Source License 1.1 with later conversion to Apache 2.0.
