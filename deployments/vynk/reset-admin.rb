# Resets the REAL instance admin's password to OPENPROJECT_SEED__ADMIN__USER__PASSWORD (from Infisical) and clears login lockout.
# Also makes sure built-in system accounts stay locked and password-less.
puts "== admin-capable accounts =="
User.where(admin: true).order(:id).each do |u|
  puts "id=#{u.id} type=#{u.type} login=#{u.login.inspect} mail=#{u.mail.inspect} status=#{u.status}"
end

# built-in accounts (System, Anonymous, Deleted) must never be loginable
[SystemUser, AnonymousUser, DeletedUser].each do |klass|
  rec = klass.first
  next unless rec
  rec.update_columns(status: User.statuses[:locked], hashed_password: "")
  puts "locked built-in #{klass.name} id=#{rec.id}"
rescue => e
  puts "built-in #{klass.name}: #{e.class} #{e.message}"
end

pw = ENV.fetch("OPENPROJECT_SEED__ADMIN__USER__PASSWORD")
user = User.where(type: "User", admin: true).order(:id).first
raise "no real admin user found" unless user

mail = ENV["OPENPROJECT_SEED__ADMIN__USER__MAIL"].to_s
if mail.present?
  user.login = mail
  user.mail = mail
end
name = ENV["OPENPROJECT_SEED__ADMIN__USER__NAME"].to_s.strip
if name.present?
  first, last = name.split(/\s+/, 2)
  user.firstname = first
  user.lastname = last.presence || first
end

user.password = pw
user.password_confirmation = pw
user.force_password_change = false if user.respond_to?(:force_password_change=)
user.failed_login_count = 0 if user.respond_to?(:failed_login_count=)
user.last_failed_login_on = nil if user.respond_to?(:last_failed_login_on=)
user.save!(validate: false)
user.update_columns(status: User.statuses[:active])
puts "ADMIN RESET OK: login=#{user.login.inspect} mail=#{user.mail.inspect} status=#{user.reload.status}"
