# Resets the instance admin's password to OPENPROJECT_SEED__ADMIN__USER__PASSWORD (from Infisical) and clears login lockout.
pw = ENV.fetch("OPENPROJECT_SEED__ADMIN__USER__PASSWORD")
user = User.admin.order(:id).first
raise "no admin user found" unless user

user.password = pw
user.password_confirmation = pw
user.force_password_change = false if user.respond_to?(:force_password_change=)
user.failed_login_count = 0 if user.respond_to?(:failed_login_count=)
user.last_failed_login_on = nil if user.respond_to?(:last_failed_login_on=)
user.save!(validate: false)
user.update_columns(status: Principal.statuses[:active]) rescue nil
puts "admin password reset for login=#{user.login.inspect} mail=#{user.mail.inspect}"
