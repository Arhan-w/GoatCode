name: Feature Request
description: Suggest a new feature
title: "[FEATURE] "
labels: ["enhancement", "needs-triage"]

body:
  - type: markdown
    attributes:
      value: |
        Thank you for suggesting a feature! Help us understand what you'd like.

  - type: textarea
    id: problem
    attributes:
      label: Problem / Use Case
      description: Describe the problem you're trying to solve or use case
      placeholder: "What problem would this solve?"
    validations:
      required: true

  - type: textarea
    id: solution
    attributes:
      label: Proposed Solution
      description: How do you think this should work?
      placeholder: "Describe your proposed solution"
    validations:
      required: true

  - type: textarea
    id: alternatives
    attributes:
      label: Alternative Solutions
      description: Other approaches you've considered
      placeholder: "Any alternatives?"

  - type: textarea
    id: context
    attributes:
      label: Additional Context
      description: Any other relevant information?
      placeholder: "Links, screenshots, code examples, etc."

  - type: checkboxes
    id: checklist
    attributes:
      label: Checklist
      options:
        - label: I've searched for similar feature requests
          required: true
        - label: This is a single, focused feature request
          required: true
