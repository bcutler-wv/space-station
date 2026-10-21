{
  function combine(kind, first, rest) {
    if (!rest.length) return first;
    return { kind, children: [first, ...rest] };
  }
  function decoded(parts) {
    return { text: parts.map((part) => part.text).join(''),
      unescapedColon: parts.some((part) => part.text === ':' && !part.escaped) };
  }
}

Start
  = _ expression:Or _ !. { return expression; }

Or
  = first:And rest:(_ "OR" !WordContinuation _ right:And { return right; })*
    { return combine('or', first, rest); }

And
  = first:Unary rest:(Space+ !("OR" !WordContinuation) next:Unary { return next; })*
    { return combine('and', first, rest); }

Unary
  = signs:"-"* primary:Primary {
      return signs.length % 2 === 0 ? primary : { kind: 'not', child: primary };
    }

Primary
  = Group / Filter / Phrase / Word

Group
  = "(" _ expression:Or _ ")" { return expression; }

Filter
  = name:Identifier ":" value:Value {
      return { kind: 'filter', name, value, offset: location().start.offset };
    }

Phrase
  = value:Quoted { return { kind: 'term', value, quoted: true }; }

Word
  = !("OR" !WordContinuation) value:Bare {
      return { kind: 'term', value: value.text, quoted: false,
        unescapedColon: value.unescapedColon };
    }

Value
  = value:Quoted { return { text: value, quoted: true }; }
  / value:Bare { return { text: value.text, quoted: false }; }

Identifier
  = $([A-Za-z_][A-Za-z0-9_-]*)

Quoted
  = '"' parts:(Escaped / QuotedCharacter)* '"' { return decoded(parts).text; }

Bare
  = parts:(Escaped / BareCharacter)+ { return decoded(parts); }

Escaped
  = "\\" character:. { return { text: character, escaped: true }; }

QuotedCharacter
  = character:[^"\\\r\n] { return { text: character, escaped: false }; }

BareCharacter
  = character:[^\\ \t\r\n()"] { return { text: character, escaped: false }; }

WordContinuation
  = [^ \t\r\n()]

Space
  = [ \t\r\n]

_
  = Space*
