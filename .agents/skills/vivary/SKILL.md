```markdown
# vivary Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill provides guidance on contributing to the `vivary` Python codebase. It covers established coding conventions, file organization, commit patterns, and the main workflow for updating or creating features in the `create-vivary` package. This will help you write consistent code, structure your contributions, and run or write tests effectively.

## Coding Conventions

**File Naming**
- Use PascalCase for file names.
  - Example: `CreateVivary.py`

**Import Style**
- Use relative imports within packages.
  - Example:
    ```python
    from .utils import HelperClass
    ```

**Export Style**
- Use named exports (explicitly define what is exported).
  - Example:
    ```python
    __all__ = ["VivaryClass", "helper_function"]
    ```

**Commit Patterns**
- Commits are mixed in type but may use prefixes like `ci`.
- Keep commit messages concise (~38 characters on average).
  - Example: `ci: update workflow for create-vivary`

## Workflows

### update-create-vivary
**Trigger:** When you want to add or enhance functionality in the `create-vivary` package.  
**Command:** `/update-create-vivary`

1. **Edit or add implementation**  
   Update or create code in `packages/create-vivary/create_vivary.py`.
   ```python
   class VivaryFeature:
       def new_method(self):
           pass
   ```
2. **Update documentation**  
   Edit `packages/create-vivary/README.md` to reflect your changes.
   ```markdown
   ## New Feature
   Description of the new method and usage.
   ```
3. **Add or update tests**  
   Write or modify tests in `packages/create-vivary/tests/test_create_vivary.py`.
   ```python
   def test_new_method():
       feature = VivaryFeature()
       assert feature.new_method() is None
   ```

## Testing Patterns

- **Framework:** Not explicitly detected; use standard Python `unittest` or `pytest` as appropriate.
- **File Pattern:** Test files are named with `.test.` in the filename.
  - Example: `test_create_vivary.py`
- **Test Example:**
  ```python
  def test_feature_behavior():
      result = some_function()
      assert result == expected_value
  ```

## Commands

| Command                | Purpose                                                         |
|------------------------|-----------------------------------------------------------------|
| /update-create-vivary  | Start the workflow to add or update features in create-vivary   |
```