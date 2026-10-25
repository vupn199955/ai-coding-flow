---
id: list-users
depends_on: [create-users]
---

# Add user listing

## Goal

Using the user contracts and persistence introduced by create-users, implement a user listing operation consistent with this repository’s architecture.

## Acceptance criteria

- Return users in a stable, documented order.
- Follow the existing pagination conventions if the repository has them.
- Handle an empty result set and persistence failures correctly.
- Preserve the user creation behavior and tests.

## Required unit tests

- A populated result set.
- An empty result set.
- Stable ordering and pagination where applicable.
- Persistence failures.
