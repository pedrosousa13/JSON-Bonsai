import { describe, expect, test } from "vitest";

import { serializeDelimited, type DelimitedTable } from "./csv";

const simple: DelimitedTable = {
  columns: ["a", "b"],
  rows: [
    ["1", "2"],
    ["3", "4"],
  ],
};

describe("serializeDelimited (CSV)", () => {
  test("joins fields with commas and records with CRLF", () => {
    expect(serializeDelimited(simple, "csv")).toBe("a,b\r\n1,2\r\n3,4");
  });

  test("a header row only, no data rows", () => {
    expect(serializeDelimited({ columns: ["x", "y"], rows: [] }, "csv")).toBe(
      "x,y"
    );
  });

  test("quotes fields containing the delimiter", () => {
    expect(
      serializeDelimited(
        { columns: ["name"], rows: [["Smith, John"]] },
        "csv"
      )
    ).toBe('name\r\n"Smith, John"');
  });

  test("quotes and doubles embedded double quotes", () => {
    expect(
      serializeDelimited(
        { columns: ["q"], rows: [['He said "hi"']] },
        "csv"
      )
    ).toBe('q\r\n"He said ""hi"""');
  });

  test("quotes fields containing LF, CR, and CRLF", () => {
    expect(
      serializeDelimited({ columns: ["c"], rows: [["a\nb"]] }, "csv")
    ).toBe('c\r\n"a\nb"');
    expect(
      serializeDelimited({ columns: ["c"], rows: [["a\rb"]] }, "csv")
    ).toBe('c\r\n"a\rb"');
    expect(
      serializeDelimited({ columns: ["c"], rows: [["a\r\nb"]] }, "csv")
    ).toBe('c\r\n"a\r\nb"');
  });

  test("preserves leading and trailing spaces without quoting them", () => {
    expect(
      serializeDelimited({ columns: ["c"], rows: [["  padded  "]] }, "csv")
    ).toBe("c\r\n  padded  ");
  });

  test("leaves empty fields empty", () => {
    expect(
      serializeDelimited({ columns: ["a", "b"], rows: [["", "x"]] }, "csv")
    ).toBe("a,b\r\n,x");
  });

  test("quotes header names that need escaping", () => {
    expect(
      serializeDelimited({ columns: ['a,b', "c"], rows: [] }, "csv")
    ).toBe('"a,b",c');
  });

  test("does not quote a tab inside a CSV field", () => {
    expect(
      serializeDelimited({ columns: ["c"], rows: [["a\tb"]] }, "csv")
    ).toBe("c\r\na\tb");
  });
});

describe("serializeDelimited (TSV)", () => {
  test("joins fields with tabs and records with CRLF", () => {
    expect(serializeDelimited(simple, "tsv")).toBe("a\tb\r\n1\t2\r\n3\t4");
  });

  test("quotes fields containing a tab", () => {
    expect(
      serializeDelimited({ columns: ["c"], rows: [["a\tb"]] }, "tsv")
    ).toBe('c\r\n"a\tb"');
  });

  test("does not quote a comma inside a TSV field", () => {
    expect(
      serializeDelimited(
        { columns: ["name"], rows: [["Smith, John"]] },
        "tsv"
      )
    ).toBe("name\r\nSmith, John");
  });

  test("still quotes double quotes and newlines in TSV", () => {
    expect(
      serializeDelimited({ columns: ["c"], rows: [['x"y']] }, "tsv")
    ).toBe('c\r\n"x""y"');
    expect(
      serializeDelimited({ columns: ["c"], rows: [["x\ny"]] }, "tsv")
    ).toBe('c\r\n"x\ny"');
  });
});

describe("formula neutralization", () => {
  test("prefixes a leading = with a single quote, then quotes by RFC 4180", () => {
    expect(
      serializeDelimited(
        {
          columns: ["name"],
          rows: [['=HYPERLINK("http://evil","click")']],
        },
        "csv"
      )
    ).toBe('name\r\n"\'=HYPERLINK(""http://evil"",""click"")"');
  });

  test("prefixes every formula-leading character", () => {
    // A tab needs no quoting in CSV; a CR does.
    expect(
      serializeDelimited(
        {
          columns: ["c"],
          rows: [["=a"], ["+a"], ["-a"], ["@a"], ["\ta"], ["\ra"]],
        },
        "csv"
      )
    ).toBe("c\r\n'=a\r\n'+a\r\n'-a\r\n'@a\r\n'\ta\r\n\"'\ra\"");
  });

  test("prefixes a string that looks like a negative number", () => {
    expect(serializeDelimited({ columns: ["c"], rows: [["-5"]] }, "csv")).toBe(
      "c\r\n'-5"
    );
  });

  test("leaves a numeric cell unprefixed", () => {
    expect(
      serializeDelimited(
        { columns: ["c"], rows: [[{ text: "-5", numeric: true }]] },
        "csv"
      )
    ).toBe("c\r\n-5");
  });

  test("prefixes formula-leading header names", () => {
    expect(
      serializeDelimited({ columns: ["=cmd", "ok"], rows: [] }, "csv")
    ).toBe("'=cmd,ok");
  });

  test("leaves empty and ordinary cells untouched", () => {
    expect(
      serializeDelimited(
        { columns: ["a", "b"], rows: [["", "plain text"]] },
        "csv"
      )
    ).toBe("a,b\r\n,plain text");
  });

  test("only the first character triggers a prefix", () => {
    expect(
      serializeDelimited({ columns: ["c"], rows: [["a=b"]] }, "csv")
    ).toBe("c\r\na=b");
  });

  test("neutralizes on the TSV path too", () => {
    expect(
      serializeDelimited(
        { columns: ["c"], rows: [["=a"], [{ text: "-5", numeric: true }]] },
        "tsv"
      )
    ).toBe("c\r\n'=a\r\n-5");
  });
});
