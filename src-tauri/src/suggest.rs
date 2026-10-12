//! The "smart label" engine.
//!
//! Every saved transaction teaches the app: the label, how often it is used,
//! when it was last used, in which kind of transaction, with which party,
//! the amount and the account split. When the user types, candidates are
//! ranked by a mix of:
//!
//! * **text match** – exact / prefix / word-prefix / contains / typo-tolerant / fuzzy,
//! * **frecency**   – frequency of use, decayed by how long ago it was last used,
//! * **context**    – how often the label was used with the current kind and party.

use chrono::{DateTime, Utc};

/// Lower-case, trim and collapse whitespace so "  Rent  OFFICE" == "rent office".
pub fn normalize(s: &str) -> String {
    s.split_whitespace()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Optimal string alignment distance (Levenshtein + adjacent transpositions).
pub fn osa_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(d[i - 2][j - 2] + 1);
            }
            d[i][j] = v;
        }
    }
    d[n][m]
}

fn is_subsequence(q: &str, s: &str) -> bool {
    let mut it = s.chars();
    q.chars().all(|c| it.any(|x| x == c))
}

fn char_prefix(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// How well `query` matches `label` (both already normalized). 0 means no match.
pub fn match_score(query: &str, label: &str) -> f64 {
    if query.is_empty() {
        return 0.5;
    }
    if label == query {
        return 1.0;
    }
    if label.starts_with(query) {
        return 0.95;
    }
    let words: Vec<&str> = label.split(' ').collect();
    if words.iter().any(|w| w.starts_with(query)) {
        return 0.8;
    }
    // Multi-word queries: every query word prefixes some label word ("of re" -> "office rent").
    let qwords: Vec<&str> = query.split(' ').collect();
    if qwords.len() > 1 && qwords.iter().all(|q| words.iter().any(|w| w.starts_with(q))) {
        return 0.75;
    }
    if label.contains(query) {
        return 0.65;
    }
    // Typo tolerance: compare against a prefix of the same length.
    let qlen = query.chars().count();
    if qlen >= 3 {
        let max_typos = if qlen >= 7 { 2 } else { 1 };
        let candidates = std::iter::once(label).chain(words.iter().copied());
        for c in candidates {
            if osa_distance(query, &char_prefix(c, qlen)) <= max_typos {
                return 0.5;
            }
        }
    }
    if qlen >= 2 && is_subsequence(query, label) {
        let llen = label.chars().count().max(1) as f64;
        return 0.15 + 0.25 * (qlen as f64 / llen);
    }
    0.0
}

/// Learned facts about a label used to rank it.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub key: String,
    pub uses: i64,
    pub last_used: DateTime<Utc>,
    /// Number of uses with the transaction kind currently being entered.
    pub kind_uses: i64,
    /// Number of uses with the party currently selected.
    pub party_uses: i64,
    /// Number of uses with the chantier currently selected.
    pub chantier_uses: i64,
}

/// Frequency of use, decayed by recency (half weight after ~2 weeks of not using it).
pub fn frecency(uses: i64, last_used: DateTime<Utc>, now: DateTime<Utc>) -> f64 {
    let days = (now - last_used).num_seconds().max(0) as f64 / 86_400.0;
    let freq = (1.0 + uses.max(0) as f64).ln();
    freq * (0.4 + 0.6 / (1.0 + days / 14.0))
}

/// Final ranking score, or `None` if the label does not match the query at all.
pub fn score(query: &str, c: &Candidate, now: DateTime<Utc>) -> Option<f64> {
    let m = match_score(query, &c.key);
    if m <= 0.0 {
        return None;
    }
    let uses = c.uses.max(1) as f64;
    let ctx_kind = (c.kind_uses as f64 / uses).min(1.0);
    let ctx_party = (c.party_uses as f64 / uses).min(1.0);
    let ctx_chantier = (c.chantier_uses as f64 / uses).min(1.0);
    Some(m * 4.0 + frecency(c.uses, c.last_used, now) + ctx_kind * 1.0 + ctx_party * 1.5 + ctx_chantier * 1.2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn cand(key: &str, uses: i64, days_ago: i64) -> Candidate {
        Candidate {
            key: key.into(),
            uses,
            last_used: Utc::now() - Duration::days(days_ago),
            kind_uses: 0,
            party_uses: 0,
            chantier_uses: 0,
        }
    }

    #[test]
    fn normalizes() {
        assert_eq!(normalize("  Rent   OFFICE "), "rent office");
        assert_eq!(normalize("Électricité"), "électricité");
    }

    #[test]
    fn match_levels() {
        assert_eq!(match_score("rent", "rent"), 1.0);
        assert!(match_score("re", "rent office") > match_score("of", "rent office"));
        assert!(match_score("of", "rent office") > match_score("ffi", "rent office"));
        assert!(match_score("of re", "office rent") > 0.7);
        // typo
        assert!(match_score("elecricity", "electricity bill") > 0.0);
        assert!(match_score("rnet", "rent") > 0.0);
        // fuzzy subsequence
        assert!(match_score("ebl", "electricity bill") > 0.0);
        assert_eq!(match_score("xyz", "electricity bill"), 0.0);
    }

    #[test]
    fn frequent_and_recent_wins() {
        let now = Utc::now();
        let often = cand("fuel", 30, 1);
        let rare = cand("furniture", 1, 1);
        let old = cand("fuel tax", 30, 400);
        let s_often = score("fu", &often, now).unwrap();
        let s_rare = score("fu", &rare, now).unwrap();
        let s_old = score("fu", &old, now).unwrap();
        assert!(s_often > s_rare);
        assert!(s_often > s_old);
    }

    #[test]
    fn context_boosts() {
        let now = Utc::now();
        let a = cand("payment", 10, 3);
        let mut b = cand("payroll", 10, 3);
        b.party_uses = 10;
        assert!(score("pay", &b, now).unwrap() > score("pay", &a, now).unwrap());
    }

    #[test]
    fn osa() {
        assert_eq!(osa_distance("abc", "abc"), 0);
        assert_eq!(osa_distance("abc", "acb"), 1);
        assert_eq!(osa_distance("kitten", "sitting"), 3);
    }
}
