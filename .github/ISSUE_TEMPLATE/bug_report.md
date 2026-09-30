name: Bug Report
description: Report a bug or issue
title: "[BUG] "
labels: ["bug", "needs-triage"]

body:
  - type: markdown
    attributes:
      value: |
        Thank you for reporting a bug! Please fill out the form below as completely as possible.

  - type: textarea
    id: description
    attributes:
      label: Description
      description: A clear and concise description of what the bug is
      placeholder: "What happened? What did you expect to happen?"
    validations:
      required: true

  - type: textarea
    id: steps
    attributes:
      label: Steps to Reproduce
      description: Steps to reproduce the behavior
      placeholder: |
        1. Run `goat`
        2. Execute `/index`
        3. Search for symbol
    validations:
      required: true

  - type: textarea
    id: environment
    attributes:
      label: Environment
      description: |
        Your system information
      value: |
        - OS: 
        - GoatCode version: 
        - Node/Bun version: 
        - LLM Provider (if applicable): 
      validations:
        required: true

  - type: textarea
    id: logs
    attributes:
      label: Error Logs
      description: Run `/doctor` and paste the output, or provide error logs
      render: bash
      placeholder: "Paste error logs here"

  - type: checkboxes
    id: checklist
    attributes:
      label: Checklist
      options:
        - label: I've searched for existing issues
          required: true
        - label: I've tried running `/doctor` to check my setup
          required: false
        - label: I'm using the latest version of GoatCode
          required: false
