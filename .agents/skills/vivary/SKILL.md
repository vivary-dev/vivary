```markdown
# vivary Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the core development patterns and conventions used in the `vivary` Python codebase. You'll learn about file naming, import/export styles, commit patterns, and how to work with and write tests in this repository. The guide also provides suggested commands for common workflows.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `dataProcessor.py`, `userManager.py`

### Import Style
- Use **relative imports** within modules.
  - Example:
    ```python
    from .utils import calculateTotal
    from ..models import User
    ```

### Export Style
- Use **named exports** (explicitly define what is exported).
  - Example:
    ```python
    __all__ = ['calculateTotal', 'UserManager']
    ```

### Commit Patterns
- Commit types are **mixed**, with common prefixes like `exo` and `chore`.
- Commit messages are concise (average 54 characters).
  - Example:
    ```
    chore: update dependencies for security
    exo: add new data processing step
    ```

## Workflows

### Starting a New Feature
**Trigger:** When beginning work on a new feature.
**Command:** `/start-feature`

1. Create a new branch with a descriptive name (e.g., `feature/userProfile`).
2. Implement the feature using camelCase file naming and relative imports.
3. Add or update tests in files matching `*.test.*`.
4. Commit changes with an appropriate prefix (e.g., `exo: ...`).
5. Push the branch and open a pull request.

### Running Tests
**Trigger:** Before pushing changes or merging code.
**Command:** `/run-tests`

1. Identify test files (pattern: `*.test.*`).
2. Run tests using the project's preferred test runner (framework unknown; check project docs or use `pytest` as a default).
   - Example:
     ```
     pytest
     ```
3. Review results and fix any failing tests.

### Refactoring Code
**Trigger:** When improving code structure or readability.
**Command:** `/refactor`

1. Refactor code while maintaining camelCase file naming and relative imports.
2. Update named exports as needed.
3. Ensure all tests still pass.
4. Commit with a `chore:` prefix.

## Testing Patterns

- Test files follow the pattern `*.test.*` (e.g., `userManager.test.py`).
- The specific test framework is unknown; default to Python standards (e.g., `unittest` or `pytest`).
- Place test files alongside the code they test or in a dedicated test directory.
- Example test file:
  ```python
  # userManager.test.py

  import unittest
  from .userManager import UserManager

  class TestUserManager(unittest.TestCase):
      def test_create_user(self):
          manager = UserManager()
          user = manager.create_user('alice')
          self.assertEqual(user.name, 'alice')

  if __name__ == '__main__':
      unittest.main()
  ```

## Commands
| Command         | Purpose                                   |
|-----------------|-------------------------------------------|
| /start-feature  | Begin work on a new feature               |
| /run-tests      | Run all tests in the repository           |
| /refactor       | Refactor code while following conventions |
```
