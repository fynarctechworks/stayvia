# Stayvia — Test Plan

This is a checklist for testing Stayvia before real hotels use it.

You don't need to know anything about the code. Each test tells you what to do
and what you should see. If what you see is different, that's a bug — write it
down.

Work through it top to bottom. Tick each box as you go.

---

## Before you start

### What you need

- A computer with Chrome
- A phone (for the mobile tests near the end)
- A second Chrome window in **Incognito mode** (Ctrl+Shift+N) — you'll run two
  hotels side by side
- The login details for both test hotels

### Set up your test data first

This takes about 15 minutes. Everything later depends on it.

**1. Create the first hotel**

Go to the website, click **Start your free 14-day trial**, and create a hotel
called **Sea Breeze Inn**. Then add these five rooms:

| Room | Floor | Type | Price per night |
|------|-------|------|-----------------|
| 101 | 1 | Standard | 1,700 |
| 102 | 1 | Standard | 1,500 |
| 103 | 1 | Standard | 1,500 |
| 104 | 1 | Standard | 1,500 |
| 201 | 2 | Deluxe | 2,500 |

Room 101 is deliberately more expensive than the others. Some of the money
tests only work if the prices are different.

**2. Create the second hotel**

Open an Incognito window. Sign up a second hotel called **Hill View
Residency**. Give it two rooms: **101** and **102** — the same numbers as the
first hotel, on purpose.

This second hotel exists for one reason: to prove that one hotel can never see
another hotel's information. Using the same room numbers makes any mistake
obvious straight away.

**3. Add three staff members to Sea Breeze Inn**

Go to Staff and invite one person for each job:

- An **admin** (can do everything)
- A **front desk** person
- A **housekeeping** person

You'll need to log in as each of them later.

**4. Add two guests**

- One guest with full details and an Aadhaar card uploaded. Write down the
  Aadhaar number — you'll search for it later.
- One walk-in guest with just a name and phone number.

### How to record what you find

For each test, tick one:

- **Pass** — it did what the test says it should
- **Fail** — it did something else
- **Blocked** — you couldn't run it (for example, card payments aren't set up
  yet). Blocked is not the same as Fail.

**When something fails, write down:**

1. Which test number
2. What page you were on
3. Who you were logged in as
4. What you expected, and what actually happened — with the exact numbers
5. A screenshot

### How to look "under the bonnet"

A few tests ask you to check what the website is doing behind the scenes.
It sounds technical but it's four clicks:

1. Press **F12**
2. Click the **Network** tab at the top
3. Tick the **Preserve log** box
4. Now do the thing you're testing

A list appears. Anything in **red** has failed. Click a red line and you'll see
the error message. Copy that into your bug report.

### Two things that are not ready yet

Some tests can't be run until these are set up. Mark them **Blocked**:

- **Card payments for the Stayvia subscription** — not connected yet. The
  free trial still works normally.
- **WhatsApp messages** — not connected yet, so no real messages are sent.

---

## Part 1 — Does it work at all?

Do this first. It takes 20 minutes. If anything here fails, stop and get it
fixed before doing anything else.

- [ ] **1. The website opens**

  Go to the Stayvia web address.

  *You should see:* the login page, with the Stayvia logo. There should be a
  padlock in the address bar, and no warning about the site being unsafe.

- [ ] **2. The system behind the website is running**

  Go to the address ending in `/health`.

  *You should see:* a short line of text saying `"status":"ok"`. If the page
  doesn't load at all, the system is down.

- [ ] **3. Logging in with the wrong password fails properly**

  Type a real email address and a deliberately wrong password. Click Sign in.

  *You should see:* a message saying the login details are wrong.

  *You should NOT see:* a message saying **"Invalid API key"**. That means the
  website was set up incorrectly and nobody can log in at all.

- [ ] **4. Logging in works**

  Now log in with the correct password.

  *You should see:* the dashboard, showing your hotel's name.

- [ ] **5. Information is actually saved**

  Add a room. Then press **Ctrl+Shift+R** to force the page to fully reload.

  *You should see:* the room is still there, with the right price. If it
  disappears, it was never really saved.

- [ ] **6. Every page opens without errors**

  Visit each page in turn: Dashboard, Rooms, Reservations, Guests,
  Housekeeping, Invoices, Reports, Settings.

  *You should see:* each page loads and shows something. No page shows an
  error message.

- [ ] **7. You stay logged in**

  Press F5 to refresh. Then close the tab and open the site again.

  *You should see:* you're still logged in. You shouldn't have to type your
  password again.

- [ ] **8. Logging out really logs you out**

  Log out. Then press the browser's Back button a few times.

  *You should see:* the login page. You should not be able to get back to any
  hotel information.

---

## Part 2 — Signing in and passwords

- [ ] **9. An email that doesn't exist gives the same message**

  Try logging in with an email address that was never registered.

  *You should see:* the same general "wrong details" message as a wrong
  password. It should not say "this email doesn't exist" — that would tell a
  stranger which email addresses are real.

- [ ] **10. Forgotten password works**

  Click **Forgot password**. Enter the email. Open the email that arrives,
  click the link, and set a new password.

  *You should see:* the new password works. Then check that the **old**
  password no longer works.

- [ ] **11. The password reset link only works once**

  Click the same link from that email again.

  *You should see:* a message that the link has already been used or expired.

- [ ] **12. A shared link takes you where you were going**

  Log out. Paste the web address of a specific booking into the address bar.
  You'll be asked to log in. Do so.

  *You should see:* the booking you originally asked for — not the dashboard.

---

## Part 3 — Rooms

- [ ] **13. Adding a room works**

  Add a room with a number, floor, type and price.

  *You should see:* it appears in the room list and on the dashboard, with a
  status of **available**.

- [ ] **14. Two rooms can't have the same number**

  Try to add a second room numbered 101 in Sea Breeze Inn.

  *You should see:* it's refused with a clear message.

  Now add a room numbered 101 in **Hill View Residency** (the other hotel).

  *You should see:* that one is allowed. Different hotels can use the same
  room numbers.

- [ ] **15. A room's status follows the guest**

  Watch room 101 on the dashboard as you do each step:

  | What you do | Room should show |
  |---|---|
  | Nothing yet | Available |
  | Make a confirmed booking | Reserved |
  | Check the guest in | Occupied |
  | Check the guest out | Needs cleaning |
  | Housekeeping marks it clean | Available |

- [ ] **16. A room under repair can't be sold**

  Report a problem with room 103.

  *You should see:* room 103 no longer appears when you try to book a room, or
  swap a room, or add a room. The floor's "free rooms" count drops by one.

- [ ] **17. Clicking a room under repair shows you the problem**

  On the dashboard, click room 103.

  *You should see:* an option called **View Issue** that opens the actual
  repair job.

  *You should NOT see:* only an option to mark it available again. That would
  let staff clear the status without anyone fixing anything.

- [ ] **18. Clicking an occupied room opens the guest's booking**

  Click a room that has a guest in it.

  *You should see:* that guest's booking. Not the repairs page.

- [ ] **19. The same works on the guest's last day**

  Find a guest who was moved to a different room during their stay, on the day
  they're leaving. Click their room.

  *You should see:* their booking opens correctly.

  *Why this matters:* this used to open the wrong page on the last day only.

- [ ] **20. The floor summary is easy to read**

  Look at the summary line for floor 1 on the dashboard.

  *You should see:* something plain like **"1 of 4 free tonight"**, sitting
  under the floor heading. Ask someone who's never used Stayvia what it means —
  they should get it right away.

- [ ] **21. The same room can't be booked twice**

  Book room 101 from the 10th to the 14th. Now try to book the same room from
  the 12th to the 16th.

  *You should see:* it's refused, because the dates overlap.

  Now try the 14th to the 16th. *You should see:* this one is allowed — the
  first guest has already left.

---

## Part 4 — Booking a guest in

- [ ] **22. Making a booking**

  Create a booking: pick a guest, choose dates five nights apart, pick room
  101.

  *You should see:* the booking is created with a reference number ending in
  **0001** if it's the hotel's first. The price should fill in automatically
  as 1,700.

- [ ] **23. A booking with two rooms**

  Make a two-night booking with room 101 (1,700) and room 201 (2,500).

  *You should see:* both rooms listed on one booking. The total should be
  **8,400** — that's (1,700 + 2,500) × 2 nights.

- [ ] **24. A day-use booking charges one night only**

  Make a booking and set the type to **short stay**, arriving and leaving the
  same day, in a 1,500 room.

  *You should see:* the total is **1,500**.

  Now change the leaving date to three days later, keeping it as a short stay.

  *You should see:* the total is still **1,500**.

- [ ] **25. Free stays don't count as income**

  Write down today's income figure on the dashboard. Now make a booking marked
  **complimentary** and check the guest in.

  *You should see:* the income figure hasn't changed. But the room does show
  as occupied, because someone really is in it.

- [ ] **26. Silly dates are refused**

  Try to make a booking where the leaving date is before the arrival date.

  *You should see:* it's refused with a clear message.

- [ ] **27. Every booking status can be filtered**

  On the bookings list, filter by each status one at a time: enquiry, hold,
  awaiting payment, confirmed, checked in, checked out, cancelled, no-show.

  *You should see:* each filter shows a list, or an empty list. None of them
  should show an error.

- [ ] **28. Checking a guest in**

  Open a booking arriving today and check the guest in.

  *You should see:* the status changes to checked in, the room shows as
  occupied, and the arrival time matches the actual clock time in India.

- [ ] **29. A guest arriving today is highlighted**

  Look at the dashboard before their usual check-in time.

  *You should see:* the booking marked as arriving, in a calm colour. It
  should be clear they're expected, not late.

- [ ] **30. A late guest is flagged in amber**

  Look at a guest who hasn't arrived, after the normal check-in time has
  passed.

  *You should see:* an **amber** late-arrival marker. It should look different
  from both the calm "arriving" colour and the red "didn't turn up" one.

- [ ] **31. A guest who never arrives frees the room**

  Mark a booking as a no-show.

  *You should see:* the room becomes available and can be sold to someone
  else.

---

## Part 5 — Changing rooms during a stay

**This is the part where most bugs have been found. Take it slowly and check
the money after each step.**

Here's the idea. A guest's stay is stored as a set of periods:

- The room they started in
- Any room they were **moved into** partway through
- Any **extra room** added partway through

Each period has its own start and end date. The bugs happened when the system
forgot this and charged every room for the whole stay.

- [ ] **32. Extending a stay**

  Open a guest who's staying, and add two more nights.

  *You should see:*
  - The leaving date moves forward by exactly two nights
  - Their room is still listed **once**, not twice
  - The total goes up by exactly two nights at that room's price

- [ ] **33. The extra nights are shown clearly**

  Look at the rooms section of that booking.

  *You should see:* the original nights and the extra nights shown separately,
  each with its own number of nights and amount. Check a different extended
  booking too — it should look the same way. Not shown on some and missing on
  others.

- [ ] **34. Undoing an extension asks first**

  Find the **Undo Extension** button at the top of the booking. Click it.

  *You should see:* a confirmation question. Click Cancel.

  *You should see:* nothing has changed.

- [ ] **35. Undoing an extension removes the charge too**

  Before extending, write down the leaving date and the total. Extend by two
  nights. Then undo it and confirm.

  *You should see:*
  - The leaving date is back to what you wrote down
  - The total is back to **exactly** what you wrote down
  - There's no leftover charge for the extension anywhere
  - Refreshing the page doesn't bring it back

  *Why this matters:* the dates used to go back but the charge stayed, so the
  guest was still billed for nights that had been removed.

- [ ] **36. Moving a guest to a different room**

  Move a guest from room 101 into room 102, starting today.

  *You should see:* room 101's period ends today and room 102's begins today.
  Both appear on the booking, clearly shown as a move. On the dashboard, 102
  becomes occupied and 101 is free to clean.

- [ ] **37. Extending after a move only offers the current room**

  Now click Extend on that same booking.

  *You should see:* only room **102** — the room they're actually in.

  *You should NOT see:* room 101, which they've already left. And it should
  say it's extending **one** room, not two.

- [ ] **38. Adding an extra room partway through**

  Add room 104 to a stay, starting tonight.

  *You should see:* room 104 starts tonight, not at the beginning of the stay.
  It should be labelled as **added partway through**. The total goes up only
  by the remaining nights.

- [ ] **39. An added room is never called "swapped"**

  Look at room 104 on the booking, then on the invoice preview, then on the
  printed invoice.

  *You should see:* it says **added** in all three places.

  *You should NOT see:* "swapped" or "extended" anywhere for that room.

  *Why this matters:* an added room used to show as "swapped" on both the
  booking and the invoice, which made the bill impossible to explain to a
  guest.

- [ ] **40. Extra charges can't go on a room they've left**

  On a booking where the guest was moved from 101 to 102, add a restaurant
  charge and open the list of rooms to put it against.

  *You should see:* only room **102**. Room 101 shouldn't be selectable.

- [ ] **41. A dirty room can still be chosen**

  Mark room 103 as needing cleaning. Now try to move a guest into it.

  *You should see:* room 103 still appears in the list, marked as needing
  cleaning, with an option like **"Mark clean & select"**. Using it should
  clean the room and pick it in one go.

  *Why this matters:* dirty rooms used to be hidden completely, so staff could
  see a free room on the dashboard but couldn't use it, with no explanation.

- [ ] **42. The same works when adding a room**

  Repeat test 41, but using **Add Room** instead of moving them.

  *You should see:* exactly the same behaviour.

- [ ] **43. The room count at checkout is right**

  Take a stay that started in 101, moved to 102, and had 104 added. That's
  three room records but only **two** rooms the guest is actually in.

  *You should see:* the checkout screen says **two** rooms, not three.

---

## Part 6 — The money check

**This is the most important section in the document.**

A guest was once told at checkout that they had **overpaid by ₹14,300**. The
system had charged every room they'd ever touched for the whole length of the
stay, instead of charging each room only for the nights they actually slept
there.

The same mistake had been written in six different places in the system, so
fixing one screen left the others wrong. It's now worked out in one single
place. These tests check that every screen uses it.

### Set up this exact booking

Don't change the prices or the dates — they're chosen so a right answer and a
wrong answer can't be confused.

1. Set the tax to **5%, inclusive** in Settings (write down what it was before)
2. Book **5 nights**, arriving the 1st, leaving the 6th, in room **101 at
   1,700 a night**
3. Check the guest in on the 1st
4. On the 2nd, **move them** to room **102 at 1,500 a night** — 4 nights left
5. On the 5th, **add room 103 at 1,500** for the last night
6. Don't take any payment yet

### The right answer is ₹9,200

| What | Nights | Price | Amount |
|---|---|---|---|
| Room 101 (started here) | 1 | 1,700 | 1,700 |
| Room 102 (moved here) | 4 | 1,500 | 6,000 |
| Room 103 (added later) | 1 | 1,500 | 1,500 |
| **Total** | | | **9,200** |
| Tax at 5% (already inside the total) | | | 460 |
| Amount before tax | | | 8,740 |

**The wrong answer is ₹23,500.** That's what you get if every room is charged
for all five nights. If you see 23,500 — or any number that isn't 9,200 —
that's the bug coming back. Write down the exact number you saw.

- [ ] **44. The booking total is 9,200**

  Open the booking and read the room charges total.

- [ ] **45. The invoice preview says 9,200**

  Preview the invoice.

  *You should see:* three lines — room 101 for 1 night, room 102 for 4 nights,
  room 103 for 1 night. Total 9,200, tax 460, before-tax 8,740.

- [ ] **46. The printed invoice matches the preview**

  Check the guest out, issue the invoice, and download it.

  *You should see:* exactly the same numbers as the preview.

- [ ] **47. Checkout shows the right amount due — never "overpaid"**

  Take a payment of **3,400**. Work it out yourself: 9,200 − 3,400 = **5,800
  still to pay**. Now start the checkout.

  *You should see:* total 9,200, paid 3,400, still to pay 5,800.

  *You should NOT see:* any message saying the guest has overpaid.

- [ ] **48. Reports agree with the invoice**

  Check the dashboard income and the revenue report for those dates.

  *You should see:* this stay adding 9,200 (or 8,740 before tax). Never
  23,500.

- [ ] **49. Each line says what really happened**

  Read the descriptions on the three invoice lines.

  *You should see:* 101 as the original room, 102 as a move, 103 as **added**.
  Never 103 described as swapped.

- [ ] **50. Extending adds only the nights you asked for**

  Extend this stay by two nights.

  *You should see:* the total goes up by exactly two nights at the price of
  the room they're actually in. No other room's nights change.

- [ ] **51. Undoing brings it back to exactly 9,200**

  Undo that extension.

  *You should see:* the total is **9,200** again, and the invoice preview
  matches test 45 exactly.

---

## Part 7 — Checking out

- [ ] **52. Checking out a guest who has paid in full**

  *You should see:* nothing left to pay, the status changes to checked out,
  and the room goes into the cleaning list. No "overpaid" message.

- [ ] **53. Checking out a guest who still owes money**

  Work out what they owe yourself first, then start the checkout.

  *You should see:* the amount matches your figure to the rupee.

- [ ] **54. A guest who changed rooms is charged once**

  Take a guest who moved from 101 to 102. Add up the nights in each room at
  each room's price. Now check them out.

  *You should see:* the same figure you worked out. Not both rooms charged for
  the whole stay.

- [ ] **55. Checking out one room of a group booking**

  On a booking with rooms 101 and 201, check out only room 201.

  *You should see:* only room 201 is settled and goes to cleaning. Room 101
  stays occupied and the booking stays open with the right balance.

- [ ] **56. The checkout time is the real time**

  Write down the actual clock time. Check a guest out. Read the recorded time
  on the booking, in the activity log, and on the invoice.

  *You should see:* all three match the time you wrote down.

  *Please run this one late at night if you can* — between midnight and 5:30am
  is when time-zone mistakes show up.

---

## Part 8 — Payments and invoices

- [ ] **57. Every payment method works**

  Take four payments of 500 each: cash, UPI, card, bank transfer.

  *You should see:* the balance drops by exactly 500 each time, and all four
  appear on the collections page with the right method.

- [ ] **58. Invoice numbers start at 0001 in each hotel**

  Issue the first invoice in Sea Breeze Inn, then the first in Hill View
  Residency, then a second in Sea Breeze Inn.

  *You should see:* 0001 in both hotels, then 0002 in Sea Breeze Inn. One
  hotel's invoices should never affect the other's numbering.

- [ ] **59. Tax added on top ("exclusive")**

  Set tax to **exclusive, 12%**. Book one night at exactly 1,000.

  *You should see:* before tax 1,000, tax 120, total **1,120**.

- [ ] **60. Tax already included ("inclusive")**

  Set tax to **inclusive, 12%**. Book one night at exactly 1,000.

  *You should see:* total **1,000** — the same as the price. Tax 120, before
  tax 880.

  Remember to put the tax settings back to how you found them.

- [ ] **61. Clicking Save twice doesn't charge twice**

  Open the payment form, type 750, and double-click Save as fast as you can.
  Refresh the page.

  *You should see:* **one** payment of 750. Not two.

- [ ] **62. Paying too much is handled sensibly**

  On a booking with 1,000 left to pay, try to take 1,500.

  *You should see:* either it's refused, or the extra 500 is clearly shown as
  a refund owed or a credit. You should never be left with a strange negative
  number.

- [ ] **63. Cancelling a payment**

  Cancel a payment you've taken.

  *You should see:* the balance goes back up, the payment is marked cancelled
  rather than vanishing, and the activity log records who did it and when.

- [ ] **64. An invoice doesn't change after it's issued**

  Issue an invoice. Then go back to the booking and try to change a room price.

  *You should see:* the issued invoice still shows the original figures.

- [ ] **65. The invoice status follows the payments**

  *You should see:* **issued** when nothing is paid, **part paid** when some
  is paid, **paid** when it's all settled.

- [ ] **66. Cancelling an invoice doesn't reuse its number**

  Cancel an invoice, then issue a new one for the same stay.

  *You should see:* the cancelled one is still visible, marked as cancelled.
  The new one gets the **next** number, not the old one. Income reports drop
  by the cancelled amount.

- [ ] **67. A refund note can be raised**

  Create a credit note against an invoice for part of the amount.

  *You should see:* it's accepted and reduces what's owed. Then try to create
  a second one that would take the total refund above the invoice amount —
  that should be refused.

- [ ] **68. Adding and removing extra charges**

  Add a 500 restaurant charge, then delete it.

  *You should see:* the total goes up by 500 (plus tax as configured), then
  returns to exactly what it was before.

- [ ] **69. The day's takings add up**

  Take three payments today: 1,000 cash, 2,000 UPI, 500 card. Add them up
  yourself: 3,500.

  *You should see:* today's collections total 3,500, split correctly by
  method. And none of them appear under yesterday.

---

## Part 9 — Housekeeping and repairs

- [ ] **70. Checking out puts the room on the cleaning list**

  *You should see:* the room shows as needing cleaning, and a cleaning job
  appears for housekeeping.

- [ ] **71. Marking it clean makes it sellable again**

  Log in as housekeeping and mark the room clean.

  *You should see:* it becomes available and can be booked straight away.

- [ ] **72. Housekeeping staff don't see money**

  Log in as the housekeeping person and look around.

  *You should see:* no room prices, no invoices, no income figures, no guest ID
  documents.

- [ ] **73. Everyone sees the same room status**

  Mark a room clean in one window. Refresh the other window.

  *You should see:* the same status on the dashboard, the rooms list, and in
  the room picker.

- [ ] **74. Reporting a problem takes the room out of service**

  Report a problem with room 103.

  *You should see:* a repair job is created and room 103 can't be sold.

- [ ] **75. Fixing the problem puts the room back**

  Mark the repair job as resolved.

  *You should see:* the room can be sold again, and the finished job is still
  in the history.

- [ ] **76. Reporting a problem doesn't throw a guest out**

  Report a problem in a room that currently has a guest in it.

  *You should see:* the guest's booking is untouched. The room only becomes
  unsellable after they leave.

---

## Part 10 — Guests and ID documents

- [ ] **77. Adding a guest**

  Add a guest with name, phone and email, then search for them by name and by
  phone.

  *You should see:* they're found both ways, with the details you entered.

- [ ] **78. ID numbers are scrambled in storage**

  Add an Aadhaar number to a guest — use something memorable like
  1234 5678 9012.

  Now open the database (through the hosting dashboard) and find that guest's
  row.

  *You should see:* the ID column contains unreadable scrambled text — **not**
  the numbers you typed. Searching the database for those digits should find
  nothing.

  *Why this matters:* if someone stole a copy of the database, they still
  couldn't read anyone's ID documents.

  **If you can see the plain number in the database, stop and report it
  immediately.**

- [ ] **79. But staff can still read it**

  Open the same guest in Stayvia as someone allowed to see ID documents.

  *You should see:* the correct number, exactly as you typed it, and the
  uploaded photo.

- [ ] **80. You can search by ID number**

  Search for the full ID number.

  *You should see:* the right guest is found. A number that doesn't exist
  should return nothing, not an error.

- [ ] **81. The same person twice is spotted**

  Try to add a second guest with the same ID number in the same hotel.

  *You should see:* it's picked up as a duplicate.

  Now do the same in the **other** hotel.

  *You should see:* that one is allowed. The same traveller may genuinely stay
  at both hotels.

- [ ] **82. Guest history only shows this hotel**

  Open a guest who has stayed at both hotels.

  *You should see:* only the stays at the hotel you're logged into.

- [ ] **83. Verification codes expire**

  Request a code, wait more than five minutes, then enter it.

  *You should see:* it's refused as expired.

- [ ] **84. Guessing a code gets locked out**

  Enter a wrong code five times in a row.

  *You should see:* further attempts are blocked, even with the right code,
  until a new one is requested.

- [ ] **85. The code isn't leaked on screen**

  With F12 open on the Network tab, request a verification code. Click the
  request and read the response.

  *You should see:* confirmation that it was sent — but **not** the code
  itself.

- [ ] **86. Deleting a guest doesn't break old invoices**

  Delete a guest who has a past stay and invoice.

  *You should see:* the old invoice still opens and still shows the name it was
  billed to. Reports are unchanged.

---

## Part 11 — Reports

India runs 5½ hours ahead of London. If a date is worked out in the wrong time
zone, anything recorded between midnight and 5:30am lands on the **wrong day**.

**Please run at least one pass of this section in that early-morning window.**
It's the only reliable way to catch this.

- [ ] **87. Today's takings land on today**

  Take a payment and look at the collections page for today, then for
  yesterday.

  *You should see:* it appears under today, and not under yesterday.

- [ ] **88. Occupancy matches a hand count**

  Count the occupied rooms yourself. Then run the occupancy report.

  *You should see:* the same number.

- [ ] **89. The tax report covers the right month**

  Find an invoice from the first day of a month and one from the last day. Run
  the tax report for that month.

  *You should see:* both included. Run it for the month before and after —
  neither should appear. Add the tax amounts yourself and check the total
  matches.

- [ ] **90. Free stays aren't counted as income**

  *You should see:* complimentary bookings missing from the income report, but
  still counted in occupancy.

- [ ] **91. Cancelled invoices leave the income figures**

  Note the income total, cancel an invoice, and run the report again.

  *You should see:* the total drops by exactly that invoice's amount.

- [ ] **92. Downloaded reports match the screen**

  Export a report to a spreadsheet and open it.

  *You should see:* the same rows, the same total, and the same dates as on
  screen.

- [ ] **93. Invoices print properly**

  Download an invoice.

  *You should see:* a tidy document with your hotel's name, address and GST
  number, and figures that match the screen. Nothing cut off or overlapping.

- [ ] **94. Downloading lots of invoices keeps working**

  Download ten invoices one after another.

  *You should see:* all ten work. If the second one onwards fails, that's a
  bug.

- [ ] **95. A huge report doesn't crash the system**

  Run the widest report over the longest date range you can.

  *You should see:* either it finishes, or it says clearly that the range is
  too big. Afterwards, check the `/health` page still says ok and the site
  still works.

- [ ] **96. An empty report is handled nicely**

  Run a report for a date range with no data.

  *You should see:* an empty result with zeros. Not an error.

- [ ] **97. Something created just before midnight is dated correctly**

  At around 11:55pm, make a booking and take a payment. After midnight, run
  the reports for the earlier day.

  *You should see:* both appear under the earlier day, and not the new one.

---

## Part 12 — Who can see what

The golden rule here: **hiding a button is not security.** Where a test says
someone shouldn't be able to do something, we check the system really refuses
it — not just that the button is missing.

- [ ] **98. Housekeeping can't reach the money pages**

  Log in as housekeeping. Then type the invoices page address straight into
  the address bar. Do the same for payments, collections and reports.

  *You should see:* none of them open. And those links shouldn't be in the
  menu either.

- [ ] **99. Front desk can't manage staff**

  Log in as the front desk person and type the staff page address directly.

  *You should see:* it doesn't open.

- [ ] **100. The system itself refuses, not just the screen**

  This one needs the F12 trick, but it's the most important test in this
  section.

  1. Log in as the **admin**. Press F12, Network tab.
  2. Take a payment on a booking.
  3. Find that line in the Network list. Right-click it and choose
     **Copy as fetch**.
  4. Log out. Log back in as the **housekeeping** person in the same browser.
  5. Press F12, click the **Console** tab, paste what you copied, press Enter.
  6. Log back in as admin and open that booking.

  *You should see:* an error saying it's forbidden, and **no** new payment on
  the booking.

  *Why this matters:* if this works, every permission in Stayvia is decoration
  and anyone can do anything.

- [ ] **101. Turning off "see income" hides income everywhere**

  Remove that permission from a role, then log in as someone with that role.

  *You should see:* income hidden on the dashboard, in reports, and on
  collections.

- [ ] **102. Copying a role doesn't change the original**

  Write down everything the admin role can do. Create a new role called
  Manager as a copy of admin, and remove one permission from it.

  *You should see:* the admin role is completely unchanged.

- [ ] **103. Changing someone's role takes effect right away**

  Change a logged-in person's role, and have them refresh the page.

  *You should see:* their new permissions apply straight away. No new account
  needed.

- [ ] **104. The last admin can't be removed**

  As the only admin, try to change your own role or delete your own account.

  *You should see:* refused, with a message that at least one admin must
  remain.

- [ ] **105. Room changes during a stay need permission**

  Log in as someone without that permission.

  *You should see:* no Move Room or Add Room options, and the system refuses
  even if the request is replayed using the F12 trick from test 100.

---

## Part 13 — Keeping the two hotels apart

**This is the most serious section. A single failure here means one hotel can
see another hotel's guests, prices and income.**

**If anything fails here, stop testing and report it straight away.**

### Set up

Have Sea Breeze Inn open in your normal window and Hill View Residency open in
the Incognito window at the same time.

In the **Hill View** window, open one booking, one guest, one invoice, one room
and one payment. Copy each web address into a notepad, labelled clearly as
belonging to Hill View.

Now, in the **Sea Breeze** window, paste each address in turn.

- [ ] **106. Another hotel's booking won't open**
- [ ] **107. Another hotel's guest won't open**
- [ ] **108. Another hotel's invoice won't open — and neither will its PDF**
- [ ] **109. Another hotel's room won't open**
- [ ] **110. Another hotel's payment won't open**

  *For all five you should see:* a "not found" message, and none of the other
  hotel's names, prices or amounts anywhere on screen.

- [ ] **111. No list ever shows the other hotel's records**

  In the Sea Breeze window, visit every list: bookings, guests, rooms,
  invoices, collections, payments, expenses, credits, repairs, messages,
  housekeeping, activity, notifications, staff.

  On each one, **clear all the filters, set the widest date range, and page
  right to the end**.

  *You should see:* only Sea Breeze records. Nothing from Hill View.

  *Why the paging matters:* a missing filter is often hidden by the default
  date range or by only looking at the first page.

- [ ] **112. Search doesn't cross hotels**

  Search for a Hill View guest name, then a Hill View booking number, then
  room 101 (which both hotels have).

  *You should see:* no Hill View results at all. Room 101 should return only
  Sea Breeze's room.

- [ ] **113. Dashboard numbers only count your own hotel**

  Count Sea Breeze's occupied rooms by hand and compare with the dashboard.
  Then add a booking in Hill View and refresh Sea Breeze.

  *You should see:* the dashboard matches your hand count, and nothing changes
  when Hill View gets busier.

- [ ] **114. Reports only cover your own hotel**

  Run reports for a period where both hotels have business. Export one and
  search the file for a Hill View name.

  *You should see:* Sea Breeze figures only, and nothing from Hill View in the
  file.

- [ ] **115. Invoice numbers don't reveal the other hotel's business**

  Compare the first invoice in each hotel.

  *You should see:* both are **0001**. If Hill View's first invoice is 0002,
  the counters are shared — which quietly tells every customer how much
  business the others are doing.

- [ ] **116. Uploaded files can't be opened by the other hotel**

  Copy the web address of a photo uploaded in Hill View. Paste it into the Sea
  Breeze window, and also into a window where you're not logged in at all.

  *You should see:* it doesn't open in either.

- [ ] **117. Settings changes don't leak**

  In Sea Breeze, change the hotel name, the tax rate and the colour. Then check
  Hill View.

  *You should see:* Hill View is completely unchanged, and its invoices still
  use its own tax rate.

- [ ] **118. Staff lists don't cross over**

  *You should see:* only your own hotel's staff. You shouldn't be able to open
  or change anyone from the other hotel.

- [ ] **119. The same room number stays independent**

  Check a guest into Sea Breeze room 101. Then look at Hill View room 101.

  *You should see:* Hill View's room 101 is still empty and available.

- [ ] **120. Notifications don't cross over**

  Do something in Hill View that raises a notification. Check Sea Breeze.

  *You should see:* nothing about Hill View's activity, and no change to the
  unread count.

---

## Part 14 — Stayvia's own subscription

Some of these need card payments to be connected. Mark them **Blocked** until
that's done.

- [ ] **121. A new hotel gets a 14-day trial**

  *You should see:* the billing page shows the trial ending 14 days from
  signup, and everything in the product works during it.

- [ ] **122. Signing up twice with one email is refused**

  *You should see:* a clear message, and no second hotel created.

- [ ] **123. When the trial runs out, the product locks**

  Note how much data the hotel has. Then let the trial expire.

  *You should see:* the working pages are blocked. **No data is deleted** —
  once paid, everything is still there.

- [ ] **124. The billing page still opens when locked**

  *You should see:* it loads normally and offers a way to pay. Otherwise the
  customer is locked out with no way back in.

- [ ] **125. Paying unlocks it again** *(needs card payments)*

- [ ] **126. Cancelling keeps access until the paid period ends**

  *You should see:* everything keeps working right up to the end date, then
  locks.

- [ ] **127. Clicking Subscribe twice doesn't charge twice** *(needs card
  payments)*

---

## Part 15 — Messages

- [ ] **128. Things that happen create notifications**

  Do something notable, like checking a guest in.

  *You should see:* a notification saying what happened, who did it and when.

- [ ] **129. The first-notification popup only appears once**

  Leave the page open for a few minutes without touching it.

  *You should see:* the popup appears once and doesn't keep coming back.

- [ ] **130. Marking notifications read sticks**

  Mark one as read, then refresh.

  *You should see:* the unread count drops by one and stays down.

- [ ] **131. Message wording can be edited**

  Change a message template and save it.

  *You should see:* the new wording is used when a message goes out, with real
  names and numbers filled in.

- [ ] **132. With WhatsApp switched off, nothing goes out and nothing breaks**

  Do everything that would normally send a message.

  *You should see:* no messages arrive on the phone, **and** no errors appear.
  The booking or check-in still completes normally.

- [ ] **133. A slow messaging service doesn't block a booking**

  *You should see:* the booking is still created. Saving shouldn't hang
  forever waiting for the message to send.

---

## Part 16 — Settings and staff

- [ ] **134. Hotel details appear on the invoice**

  Set the hotel name, address and GST number, then download an invoice.

  *You should see:* all three printed at the top of the invoice.

- [ ] **135. Your logo and colours are yours alone**

  Set them in Sea Breeze and check Hill View.

  *You should see:* Hill View is unaffected, and each hotel's invoice carries
  its own branding.

- [ ] **136. Settings show what you saved**

  Change something and save. Go to another page and come back.

  *You should see:* your saved values. Then change something **without**
  saving, leave and come back — that change should be gone.

- [ ] **137. Changing the tax rate doesn't rewrite old invoices**

  Note the figures on an issued invoice. Change the tax rate. Reopen the same
  invoice.

  *You should see:* the old invoice is completely unchanged. New bookings use
  the new rate.

- [ ] **138. Inviting a staff member works**

  *You should see:* the invitation arrives, they can set a password, and they
  land in the right hotel with the right permissions.

- [ ] **139. Removing a staff member cuts them off**

  Deactivate someone.

  *You should see:* they can't log in. But their past activity is still in the
  log under their name.

- [ ] **140. The activity log records who did what**

  Do four things: check a guest in, take a payment, cancel it, change a
  setting.

  *You should see:* all four in the log, with the right person, the right
  time, and which record was affected.

- [ ] **141. The activity log can't be edited**

  *You should see:* no way to change or delete an entry.

---

## Part 17 — Phones, poor internet, and things going wrong

- [ ] **142. It works properly on a phone**

  On an actual phone, do a full day's work: check the dashboard, make a
  booking, check a guest in, take a payment, check them out.

  *You should see:* every step is possible. Information shown as cards, not a
  wide table squashed sideways. Nothing cut off. The bottom menu works.

- [ ] **143. Repeated wrong passwords get slowed down**

  Try a wrong password fifteen times quickly.

  *You should see:* you're made to wait, with a message explaining why. The
  correct password works again after the wait.

- [ ] **144. One busy hotel doesn't lock out the other**

  After test 143, switch to the other hotel's window and use it.

  *You should see:* it works normally.

- [ ] **145. On a slow connection, clicking twice doesn't pay twice**

  In F12, set the network to a slow speed. Take a payment and click Save
  again while it's still going.

  *You should see:* a loading indicator, and only **one** payment when it
  finishes.

- [ ] **146. Coming back after a long break works**

  Leave the site open and untouched for half an hour, then make a booking.

  *You should see:* it works first time, with no connection error.

- [ ] **147. Error messages don't give away technical details**

  *You should see:* a plain, helpful message. Never a wall of technical text,
  file names or passwords.

- [ ] **148. No passwords are hidden in the website's code**

  Press F12, go to **Sources**, open the main script file, and press Ctrl+F.
  Search for: `secret`, `password`, `service role`, `postgres`.

  *You should see:* nothing. The only things found should be the public web
  address and public key, which are safe.

  **If you find a password or secret key, report it immediately** — anyone who
  has ever opened the site already has it, so it must be changed, not just
  removed.

---

## Part 18 — Bugs we already fixed

These all really happened. Re-run the listed tests after any change to
bookings, billing or the dashboard, to make sure they haven't come back.

- [ ] **149. Guests were charged for rooms they weren't in**

  A guest was told they'd overpaid by ₹14,300. → Run all of **Part 6**.

- [ ] **150. The repairs popup only offered to clear the status** → Test 17

- [ ] **151. Clicking an occupied room opened the repairs page** → Tests 18, 19

- [ ] **152. The floor summary was unreadable** → Test 20

- [ ] **153. Removing an extension left the charge behind** → Tests 35, 51

- [ ] **154. Extending offered rooms the guest had already left** → Test 37

- [ ] **155. Charges could be put on a room they'd left** → Test 40

- [ ] **156. The extension breakdown showed on some bookings only** → Test 33

- [ ] **157. An added room was labelled "swapped"** → Tests 39, 49

- [ ] **158. Dirty rooms vanished from the room picker** → Tests 41, 42

- [ ] **159. A "hold" made a room unsellable forever** → *Put a booking on
  hold, then try to sell that room. It should still be sellable.*

- [ ] **160. Filtering bookings by "hold" showed an error** → Test 27

- [ ] **161. A late payment message could suspend a paying customer** → Part 14

- [ ] **162. Nobody could log in — "Invalid API key"** → Tests 3 and 4

  **Run tests 3 and 4 after every single website update.** Settings are baked
  into the website when it's published, so changing a setting does nothing
  until it's published again.

---

## Before you go live

Tick these off last.

- [ ] Everything in **Part 1** passed
- [ ] Everything in **Part 6** passed (the ₹9,200 check)
- [ ] Everything in **Part 13** passed (hotels kept apart)
- [ ] Everything in **Part 18** passed (old bugs haven't come back)
- [ ] The automated tests were run and passed
- [ ] The `/health` page shows the version you meant to release
- [ ] Any passwords or keys that were shared during setup have been **changed**
- [ ] Test 148 passed — no secrets in the website code
- [ ] The key that protects guest ID documents is **backed up somewhere safe**

  This last one matters more than it looks. If that key is ever lost or
  changed, every stored ID document becomes permanently unreadable. There is no
  way to get them back.

---

## Anything left over

Write down here anything that failed, anything you couldn't test, and anything
that just felt wrong even if it technically passed.

| Test | What happened | Who found it | Date |
|---|---|---|---|
| | | | |
| | | | |
| | | | |
