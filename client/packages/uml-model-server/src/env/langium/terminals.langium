hidden terminal WS: /\s+/;
hidden terminal NEW_LINE: /\n+/;
hidden terminal TAB: /\t+/;
terminal LANGIUM_BOOL returns boolean: /true|false/;
terminal LANGIUM_INT returns number: /(-)?[0-9]+(\.[0-9]*)?/;
// Quoted string content: any character except JSON-structural characters
// ({ } [ ] : , "), whitespace, and backslash. This lets values keep realistic
// punctuation (dots, '@', apostrophes, parentheses, dashes) e.g.
// "alice.smith@example.com" or "O'Brien". Numbers/booleans still win their ties
// because LANGIUM_INT / LANGIUM_BOOL are declared earlier. Values with spaces,
// commas, colons or quotes are still sanitized upstream (a full escaped-string
// terminal would be needed to carry those, which is a larger grammar change).
terminal LANGIUM_ID: /[^\s"{}\[\]:,\\]+/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;