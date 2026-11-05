# Work authorization for Canadian citizens

Apply these rules whenever the profile has `workAuthorization.canada: "citizen"`.
They decide which postings to skip and how screening questions are answered.

**Working in Canada**
- A Canadian citizen may work for any employer in Canada with no work permit,
  visa, or sponsorship, now or in the future. Co-op work permits apply only to
  international students on study permits, never to citizens.
- Answers: "Legally eligible/authorized to work in Canada?" → **Yes**.
  "Will you now or in the future require sponsorship or a work permit to work
  in Canada?" → **No**. "Are you a Canadian citizen or permanent resident?" →
  **Yes**. "Citizenship?" → **Canadian** (add another citizenship only if the
  profile records it).
- Postings restricted to Canadian citizens or permanent residents (many federal
  and provincial government roles, and roles funded by citizenship-restricted
  programs) are open to the user on citizenship grounds.
- Security clearance: citizenship makes the user *eligible to apply* for
  Government of Canada reliability or secret clearance and Controlled Goods
  Program registration. It does not mean they *hold* one. Answer "Do you
  currently hold a clearance?" from the profile only (default **No**), and ask
  the user before answering "Are you willing to obtain one?" unless
  `standardAnswers` covers it.

**Working in the United States or elsewhere**
- Canadian citizenship is not US work authorization. Unless
  `workAuthorization.unitedStates` is `citizen` or `permanent_resident`, answer
  "Are you authorized to work in the US?" → **No**, and answer "Will you
  require sponsorship (or a visa) to work in the US?" from
  `needsSponsorship.unitedStates`, which is normally **Yes**.
- US co-op and intern terms usually need a J-1 intern visa supported by the
  employer. TN status generally requires a completed degree, so students
  rarely qualify. Treat on-site US roles as needing sponsorship unless the
  profile says otherwise.
- Skip US roles that require US citizenship, a green card, an active US
  clearance, or "no sponsorship". Canadian citizens are **not** "U.S. persons"
  under ITAR/EAR export-control rules.
- Remote roles: authorization follows where the work is physically performed.
  Remote work done from Canada for a foreign employer is covered by Canadian
  citizenship. If the posting is unclear about where work must be done, add a
  caveat instead of guessing.
- Other countries: use only `workAuthorization.otherCountries`.

Never infer citizenship, dual citizenship, clearances, or visa status the
profile does not state. If a question does not map cleanly to these rules,
ask the user once and offer to save the answer to `standardAnswers`.
