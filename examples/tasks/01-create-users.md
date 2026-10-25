---
id: create-users
depends_on: []
---

# Add user creation

## Goal

Add a user creation operation using this repository’s existing architecture. Investigate the current modules, validation, persistence, error handling, and test conventions before choosing the implementation.

## Requirements

- Accept a user name and email.
- Validate required fields and email format.
- Reject duplicate email addresses using the project’s established conflict error.
- Preserve existing behavior and API conventions.
- Avoid introducing a new framework, database, or deployment change unless the repository requires it.

## Acceptance criteria

- Valid input creates a user and returns the expected representation.
- Invalid input produces the established validation response.
- Duplicate email produces a conflict response.
- Persistence failures are handled consistently with the existing application.

## Required unit tests

- Successful creation.
- Missing or invalid fields.
- Duplicate email.
- Persistence failure.

These examples describe real requested functionality when selected for a run. Adapt them to your repository before starting.
