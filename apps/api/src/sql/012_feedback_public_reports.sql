-- Allows feedback to be submitted before login by making farm/user references optional.
alter table feedback_reports alter column farm_id drop not null;
alter table feedback_reports alter column user_id drop not null;
