import type { ReactNode } from "react";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-xl border p-4 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-6 lg:space-y-0">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="space-y-2 text-base text-muted-foreground">{children}</div>
    </section>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

/** A short guide for the crew: what each tab is for, and how to get the best from a phone and from a computer. */
export function HelpGuide() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Help</h1>

      <Block title="Signing in">
        <List
          items={[
            "Use the crew app address your employer gave you, and enter the email address they have for you. We email you a 6-digit code. There is no password.",
            "You stay signed in on that device for about a month while you use it. Sign out of a device on the Me tab.",
            "If no code arrives, check your spam folder, then ask your employer to check your email address.",
          ]}
        />
      </Block>

      <Block title="On a phone">
        <List
          items={[
            "Add the app to your Home Screen so it opens in one tap. On iPhone, open this page in Safari, tap Share, then Add to Home Screen. On Android, open the browser menu and choose Install app or Add to Home screen.",
            "Open the app before you set off, while you have a signal. Time you add without a signal is kept on your phone and sent when you are back online.",
            "Turn your screen brightness up on site and keep the app open on My day for the visit you are at.",
            "Use the Time tab for your hours and the Plus button to add time you forgot.",
          ]}
        />
      </Block>

      <Block title="On a computer">
        <List
          items={[
            "Use any current browser. There is nothing to install: sign in at the same address and bookmark it.",
            "The Time tab shows your whole week as a table. Click a day on a row and type your hours, for example 7:30, 7.5 or 7h30.",
            "The empty row at the bottom of the table is for another project or kind of work: choose it, then type hours on a day.",
            "Use a private device. On a shared computer, sign out when you finish.",
          ]}
        />
      </Block>

      <Block title="My day">
        <List
          items={[
            "Each card is a visit. Tap On my way when you leave, and I've arrived when you get there.",
            "Tick the checklist as you go. Required items must be done before you can complete the visit.",
            "Add photos on the visit while you are there. If a customer sign-off is needed, send it to them from the visit.",
            "Tap Complete the visit when the work is done.",
          ]}
        />
      </Block>

      <Block title="Your time and pay">
        <List
          items={[
            "Enter your hours on the Time tab each day, or at the end of the week. Choose the project and the activity. Use On site for normal work, or Driving or Admin.",
            "Some projects have a Start and Stop timer. If you do not see one, just enter your hours.",
            "Add work expenses in the Expenses section of the Time tab with the date, category and amount.",
            "When you have finished the week, or your days for it, tap Submit week. You can submit on any day once you have time logged. Your employer approves it. If it is sent back, change what they ask and submit again.",
            "You never see pay rates in this app. Ask your employer about pay.",
          ]}
        />
      </Block>

      <Block title="Staying safe">
        <List
          items={[
            "Lost your phone? Open the Me tab on another device and choose Sign out everywhere.",
            "This app only shows the work and time that belong to you. It does not give access to your employer's CRM.",
          ]}
        />
      </Block>
    </div>
  );
}
