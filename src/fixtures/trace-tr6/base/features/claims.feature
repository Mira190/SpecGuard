Feature: Claim filing

  @AC-1
  Scenario: Claim with policy number
    Given a claim with a policy number
    Then the claim is accepted

  @AC-4
  Scenario Outline: Late claim is rejected
    Given a claim filed <days> days after the incident
    When the claim is submitted
    Then the claim is <outcome>

    Examples:
      | days | outcome  |
      | 30   | accepted |
      | 31   | rejected |
