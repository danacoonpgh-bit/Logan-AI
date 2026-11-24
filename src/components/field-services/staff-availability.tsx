"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DAY_KEYS, DAY_LABELS, toMinutes } from "@/lib/field-services/working-hours";
import type { Product } from "@/types/products";
import { Button } from "@/components/ui/button";
import type { ServiceArea, TimeOff, WeeklyHours } from "@/types/field-services";

function PickList({
  items,
  picked,
  onChange,
  empty,
}: {
  items: { id: string; name: string }[];
  picked: string[];
  onChange: (next: string[]) => void;
  empty: string;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="grid max-h-40 gap-1.5 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2">
      {items.map((it) => (
        <li key={it.id}>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={picked.includes(it.id)}
              onCheckedChange={(v) => onChange(v === true ? [...picked, it.id] : picked.filter((x) => x !== it.id))}
            />
            <span className="truncate">{it.name}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** Weekly hours (required), the services someone does and the areas they cover (both optional). */
export function StaffAvailabilityFields({
  hours,
  onHours,
  timeOff,
  onTimeOff,
  serviceIds,
  onServiceIds,
  areaIds,
  onAreaIds,
  services,
  areas,
  part = "all",
}: {
  hours: WeeklyHours;
  onHours: (next: WeeklyHours) => void;
  timeOff: TimeOff[];
  onTimeOff: (next: TimeOff[]) => void;
  serviceIds: string[];
  onServiceIds: (next: string[]) => void;
  areaIds: string[];
  onAreaIds: (next: string[]) => void;
  services: Product[];
  areas: ServiceArea[];
  /** Which half to show: hours and time off, or services and areas. */
  part?: "all" | "hours" | "work";
}) {
  return (
    <div className="space-y-5">
      {part !== "work" && (
      <>
      <div>
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">Weekly working hours</Label>
        <p className="mb-2 text-xs text-muted-foreground">
          Required. Time outside these hours is shaded on the schedule, and you get a warning if you book them outside it.
        </p>
        <ul className="divide-y rounded-lg border">
          {DAY_KEYS.map((day) => {
            const d = hours[day];
            const bad = d !== null && toMinutes(d.end) <= toMinutes(d.start);
            return (
              <li key={day} className="flex flex-wrap items-center gap-3 p-2.5">
                <label className="flex w-36 cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={d !== null}
                    onCheckedChange={(v) => onHours({ ...hours, [day]: v === true ? { start: "09:00", end: "17:00" } : null })}
                  />
                  {DAY_LABELS[day]}
                </label>
                {d ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      aria-label={`${DAY_LABELS[day]} start`}
                      className="h-8 w-28"
                      value={d.start}
                      onChange={(e) => onHours({ ...hours, [day]: { ...d, start: e.target.value } })}
                    />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input
                      type="time"
                      aria-label={`${DAY_LABELS[day]} end`}
                      className="h-8 w-28"
                      value={d.end}
                      onChange={(e) => onHours({ ...hours, [day]: { ...d, end: e.target.value } })}
                    />
                    {bad && <span className="text-xs text-destructive">Must finish after it starts</span>}
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">Day off</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">Time off</Label>
        <p className="mb-2 text-xs text-muted-foreground">
          Optional. Whole days away, such as leave. Those days are shaded as a day off on the schedule, and you get a warning if you book them.
        </p>
        {timeOff.length > 0 && (
          <ul className="mb-2 divide-y rounded-lg border">
            {timeOff.map((t, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 p-2.5">
                <Input
                  type="date"
                  aria-label="First day away"
                  className="h-8 w-40"
                  value={t.start}
                  onChange={(e) => onTimeOff(timeOff.map((x, j) => (j === i ? { ...x, start: e.target.value, end: x.end < e.target.value ? e.target.value : x.end } : x)))}
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="date"
                  aria-label="Last day away"
                  className="h-8 w-40"
                  min={t.start}
                  value={t.end}
                  onChange={(e) => onTimeOff(timeOff.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
                />
                <Input
                  aria-label="Note"
                  className="h-8 min-w-32 flex-1"
                  maxLength={80}
                  placeholder="Annual leave"
                  value={t.note ?? ""}
                  onChange={(e) => onTimeOff(timeOff.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => onTimeOff(timeOff.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const today = new Date().toISOString().slice(0, 10);
            onTimeOff([...timeOff, { start: today, end: today, note: "" }]);
          }}
        >
          Add time off
        </Button>
      </div>
      </>
      )}

      {part !== "hours" && (
      <>
      <div>
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">Services they do</Label>
        <p className="mb-2 text-xs text-muted-foreground">
          Optional. Leave all unticked for every service. You get a warning if you put them on a project with a service they aren&apos;t set up for.
        </p>
        <PickList items={services} picked={serviceIds} onChange={onServiceIds} empty="No services yet. Add some on the Services & areas tab." />
      </div>

      <div>
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">Service areas they cover</Label>
        <p className="mb-2 text-xs text-muted-foreground">
          Optional. Leave all unticked to cover every area. You get a warning if the project address is in an area they don&apos;t cover.
        </p>
        <PickList items={areas} picked={areaIds} onChange={onAreaIds} empty="No areas yet. Add some on the Services & areas tab." />
      </div>
      </>
      )}
    </div>
  );
}
