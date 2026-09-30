Pod::Spec.new do |s|
  s.name           = 'HabitSystemApple'
  s.version        = '1.0.0'
  s.summary        = 'Native Apple capabilities for Habit System'
  s.description    = 'The local Apple module for Habit System platform adapters.'
  s.author         = 'Rami Maalouf'
  s.homepage       = 'https://github.com/rami-maalouf/habit-system'
  s.platforms      = {
    :ios => '18.6'
  }
  s.source         = { git: 'https://github.com/rami-maalouf/habit-system.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoSQLite'
  s.frameworks = 'CloudKit', 'AppIntents', 'WidgetKit'

  # swift/objective-c compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
