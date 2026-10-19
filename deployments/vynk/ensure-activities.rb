# Idempotent: makes sure the extra time-tracking activities exist (run on every deploy).
["Deployment & Cloud", "Research"].each do |name|
  activity = TimeEntryActivity.where(project_id: nil).find_or_initialize_by(name: name)
  next puts("exists: #{name}") if activity.persisted?

  activity.active = true
  activity.save!
  puts "created: #{name}"
end
