import { useEffect, useState } from "react";
import { useApp } from "../context";
import { parseAmount, toInput } from "../money";

/**
 * Amount field holding minor units. Accepts simple math ("1200+350") which is
 * evaluated on blur, and shows the computed value while typing.
 */
export function AmountInput({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: number | null;
  onChange: (cents: number | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { money, fmt } = useApp();
  const [text, setText] = useState(toInput(value, money.decimals));
  const [focused, setFocused] = useState(false);

  // Follow external changes (auto-fill, split equally) when not typing.
  useEffect(() => {
    if (!focused) setText(toInput(value, money.decimals));
  }, [value, focused, money.decimals]);

  const parsed = parseAmount(text, money.decimals);
  const isMath = /[+*/()]|.-/.test(text.trim());
  const invalid = text.trim() !== "" && parsed == null;

  return (
    <div className="amount-input">
      <input
        className={`input num ${invalid ? "invalid" : ""}`}
        inputMode="decimal"
        value={text}
        placeholder={placeholder ?? "0"}
        autoFocus={autoFocus}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseAmount(e.target.value, money.decimals));
        }}
        onBlur={() => {
          setFocused(false);
          if (parsed != null) setText(toInput(parsed, money.decimals));
        }}
      />
      {focused && isMath && parsed != null && <span className="calc">= {fmt(parsed)}</span>}
    </div>
  );
}
