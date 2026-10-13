@AC-4
Feature: Claim filing window

  Scenario Outline: Late claims are rejected
    Given an incident <days> days ago
    When the claim is filed
    Then the claim is <outcome>

    Examples:
      | days | outcome  |
      | 45   | accepted |
      | 60   | rejected |
